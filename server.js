require("dotenv").config();
const express = require("express");
const expressWs = require("express-ws");
const WebSocket = require("ws");
const twilio = require("twilio");
const https = require("https");

const app = express();
expressWs(app);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const XAI_API_KEY = process.env.XAI_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const VERIFIED_CALLER_ID = process.env.VERIFIED_CALLER_ID;
const HOSTNAME = process.env.RENDER_EXTERNAL_URL || process.env.HOSTNAME;
const AGENT_VOICE = process.env.AGENT_VOICE || "eve";
const ZAPIER_WEBHOOK_URL = process.env.ZAPIER_WEBHOOK_URL;

const AGENT_INSTRUCTIONS_WELCOME = process.env.AGENT_INSTRUCTIONS_WELCOME || process.env.AGENT_INSTRUCTIONS || "You are a helpful assistant.";
const AGENT_INSTRUCTIONS_PATIENT_UPDATE = process.env.AGENT_INSTRUCTIONS_PATIENT_UPDATE || process.env.AGENT_INSTRUCTIONS_EXPERIENCE || "You are a helpful assistant calling to check on the patient.";
const AGENT_INSTRUCTIONS_DISCHARGED = process.env.AGENT_INSTRUCTIONS_DISCHARGED || "You are a helpful assistant calling a discharged patient.";

const TRANSFER_NUMBERS = {
  clinical: "+12148107225",
  nurse: "+12142530980",
  therapy: "+12148077411",
  billing: "+12142530980",
  admin: "+12148077860",
};

// ===== Queue Settings (Pro Ultra) =====
const MAX_CONCURRENT_CALLS = 60;
const CALL_TIMEOUT_MS = 90000; // 90 seconds

const callQueue = [];
const activeCalls = new Map(); // callSid → { timeout }

if (!XAI_API_KEY || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
  console.error("Missing required environment variables");
  process.exit(1);
}

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

function sendToZapier(payload) {
  if (!ZAPIER_WEBHOOK_URL) return;

  try {
    const url = new URL(ZAPIER_WEBHOOK_URL);
    const data = JSON.stringify(payload);

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    };

    const req = https.request(options, (res) => {
      console.log(`Zapier webhook response: ${res.statusCode}`);
    });

    req.on("error", (err) => console.error("Error sending to Zapier:", err.message));
    req.write(data);
    req.end();
  } catch (err) {
    console.error("Failed to send to Zapier:", err.message);
  }
}

function closeXaiConnection(xaiWs, reason = "closed") {
  if (!xaiWs) return;
  try {
    if (xaiWs.readyState === WebSocket.OPEN || xaiWs.readyState === WebSocket.CONNECTING) {
      xaiWs.close();
      console.log(`xAI connection ${reason}`);
    }
  } catch (err) {
    console.error("Error closing xAI connection:", err.message);
  }
}

function getActiveCount() {
  return activeCalls.size;
}

function markCallFinished(callSid, reason = "finished") {
  if (!callSid) return;
  const entry = activeCalls.get(callSid);
  if (!entry) return;

  if (entry.timeout) clearTimeout(entry.timeout);
  activeCalls.delete(callSid);

  console.log(`Call ${callSid} ${reason}. Active: ${getActiveCount()} | Waiting: ${callQueue.length}`);
  processQueue();
}

async function processQueue() {
  while (getActiveCount() < MAX_CONCURRENT_CALLS && callQueue.length > 0) {
    const job = callQueue.shift();

    try {
      // Build TwiML URL and include discharge_date if present
      let twimlUrl = `${HOSTNAME}/outbound-twiml?patient_name=${encodeURIComponent(job.patient_name)}&phone_number=${encodeURIComponent(job.to)}&agent_type=${encodeURIComponent(job.agent_type)}`;
      
      if (job.discharge_date) {
        twimlUrl += `&discharge_date=${encodeURIComponent(job.discharge_date)}`;
      }

      const call = await twilioClient.calls.create({
        to: job.to,
        from: VERIFIED_CALLER_ID || TWILIO_PHONE_NUMBER,
        url: twimlUrl,
        method: "POST",
      });

      const callSid = call.sid;

      const timeout = setTimeout(() => {
        markCallFinished(callSid, "timed out (never connected)");
      }, CALL_TIMEOUT_MS);

      activeCalls.set(callSid, { timeout });

      console.log(`Call started → ${job.to} | SID: ${callSid} | Name: ${job.patient_name} | Type: ${job.agent_type} | Discharge: ${job.discharge_date || "n/a"} | Active: ${getActiveCount()} | Waiting: ${callQueue.length}`);
    } catch (err) {
      console.error("Failed to start queued call:", err.message);
    }
  }
}

// ===== API =====
app.post("/api/call", async (req, res) => {
  try {
    const { to, patient_name, agent_type = "welcome", discharge_date = null } = req.body;

    if (!to || !patient_name) {
      return res.status(400).json({ error: "Missing 'to' or 'patient_name'" });
    }

    callQueue.push({ to, patient_name, agent_type, discharge_date });
    console.log(`Call queued for ${patient_name}. Queue length: ${callQueue.length}`);

    processQueue();

    res.json({
      success: true,
      message: "Call queued",
      queue_length: callQueue.length,
      active_calls: getActiveCount(),
    });
  } catch (err) {
    console.error("Queue error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/outbound-twiml", (req, res) => {
  const patientName = req.query.patient_name || "there";
  const phoneNumber = req.query.phone_number || "";
  const agentType = req.query.agent_type || "welcome";
  const dischargeDate = req.query.discharge_date || "";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.get("host")}/media-stream">
      <Parameter name="patient_name" value="${patientName}" />
      <Parameter name="phone_number" value="${phoneNumber}" />
      <Parameter name="agent_type" value="${agentType}" />
      <Parameter name="discharge_date" value="${dischargeDate}" />
    </Stream>
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

app.post("/transfer-twiml", (req, res) => {
  const department = req.query.department || "admin";
  const targetNumber = TRANSFER_NUMBERS[department] || TRANSFER_NUMBERS.admin;

  console.log(`Transferring call to ${department}: ${targetNumber}`);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Please hold while I connect you.</Say>
  <Dial>${targetNumber}</Dial>
</Response>`;

  res.type("text/xml").send(twiml);
});

// Media Stream ↔ xAI
app.ws("/media-stream", (twilioWs, req) => {
  console.log("Twilio Media Stream connected");

  let streamSid = null;
  let callSid = null;
  let patientName = "there";
  let phoneNumber = "unknown";
  let agentType = "welcome";
  let dischargeDate = null;
  let xaiWs = null;
  let sessionReady = false;
  let transcript = [];
  let callStartTime = new Date().toISOString();

  twilioWs.on("message", (msg) => {
    const data = JSON.parse(msg);

    switch (data.event) {
      case "start":
        streamSid = data.start.streamSid;
        callSid = data.start.callSid;
        patientName = data.start.customParameters?.patient_name || "there";
        phoneNumber = data.start.customParameters?.phone_number || "unknown";
        agentType = data.start.customParameters?.agent_type || "welcome";
        dischargeDate = data.start.customParameters?.discharge_date || null;

        console.log(`Stream started | Patient: ${patientName} | Type: ${agentType} | Discharge Date: ${dischargeDate || "n/a"} | CallSid: ${callSid}`);

        // Clear timeout – call connected
        const entry = activeCalls.get(callSid);
        if (entry && entry.timeout) {
          clearTimeout(entry.timeout);
          entry.timeout = null;
        }

        // Choose instructions based on agent_type
        let baseInstructions = AGENT_INSTRUCTIONS_WELCOME;
        if (agentType === "patient_update" || agentType === "experience") {
          baseInstructions = AGENT_INSTRUCTIONS_PATIENT_UPDATE;
        } else if (agentType === "discharged") {
          baseInstructions = AGENT_INSTRUCTIONS_DISCHARGED;
        }

        xaiWs = new WebSocket("wss://api.x.ai/v1/realtime?model=grok-voice-latest", {
          headers: { Authorization: `Bearer ${XAI_API_KEY}` },
        });

        xaiWs.on("open", () => {
          console.log("Connected to xAI Realtime");

          // Build final instructions and inject discharge date when available
          let fullInstructions = `${baseInstructions}

The patient's name is ${patientName}. Always address them by name and confirm you are speaking with them at the beginning of the call.`;

          if (dischargeDate) {
            fullInstructions += `\n\nThe patient was discharged on ${dischargeDate}. Use this date naturally in the conversation when relevant.`;
          }

          fullInstructions += `\n\nYou have a tool called transfer_call. Use it when the patient wants to be transferred to a department.
Available departments: clinical, nurse, therapy, billing, admin.`;

          const sessionUpdate = {
            type: "session.update",
            session: {
              voice: AGENT_VOICE,
              instructions: fullInstructions,
              turn_detection: { type: "server_vad" },
              tools: [
                {
                  type: "function",
                  name: "transfer_call",
                  description: "Transfer the current call to a specific department.",
                  parameters: {
                    type: "object",
                    properties: {
                      department: {
                        type: "string",
                        enum: ["clinical", "nurse", "therapy", "billing", "admin"],
                        description: "The department to transfer the call to"
                      }
                    },
                    required: ["department"]
                  }
                }
              ],
              audio: {
                input:  { format: { type: "audio/pcmu" } },
                output: { format: { type: "audio/pcmu" } },
              },
            },
          };

          xaiWs.send(JSON.stringify(sessionUpdate));
          xaiWs.send(JSON.stringify({ type: "response.create" }));
          sessionReady = true;
        });

        xaiWs.on("message", async (xaiMsg) => {
          const event = JSON.parse(xaiMsg.toString());
          console.log("xAI event:", event.type);

          if (event.type === "error") {
            console.error("xAI error details:", JSON.stringify(event, null, 2));
          }

          // Transfer handling
          if (event.type === "response.function_call_arguments.done") {
            try {
              const args = JSON.parse(event.arguments || "{}");
              const department = args.department || "admin";
              console.log(`Agent requested transfer to: ${department}`);

              if (callSid) {
                const transferUrl = `${HOSTNAME}/transfer-twiml?department=${encodeURIComponent(department)}`;
                await twilioClient.calls(callSid).update({
                  url: transferUrl,
                  method: "POST",
                });
                console.log(`Call ${callSid} redirected to ${department}`);
              }
            } catch (err) {
              console.error("Transfer failed:", err.message);
            }
          }

          // Improved Transcript Logic
          if (event.type === "response.output_audio_transcript.done" && event.transcript) {
            const text = event.transcript.trim();
            if (text) {
              if (transcript.length > 0 && transcript[transcript.length - 1].speaker === "Agent") {
                const last = transcript[transcript.length - 1].text;
                if (text.startsWith(last) || last.startsWith(text)) {
                  transcript[transcript.length - 1].text = text.length > last.length ? text : last;
                } else {
                  transcript.push({ speaker: "Agent", text });
                }
              } else {
                transcript.push({ speaker: "Agent", text });
              }
            }
          }

          if (event.type === "conversation.item.input_audio_transcription.completed" && event.transcript) {
            const text = event.transcript.trim();
            if (text) {
              if (transcript.length > 0 && transcript[transcript.length - 1].speaker === "Patient") {
                const last = transcript[transcript.length - 1].text;
                if (text.startsWith(last) || last.startsWith(text)) {
                  transcript[transcript.length - 1].text = text.length > last.length ? text : last;
                } else {
                  transcript.push({ speaker: "Patient", text });
                }
              } else {
                transcript.push({ speaker: "Patient", text });
              }
            }
          }

          // Audio to Twilio
          if (event.type === "response.output_audio.delta" && event.delta) {
            if (twilioWs.readyState === WebSocket.OPEN) {
              twilioWs.send(JSON.stringify({
                event: "media",
                streamSid,
                media: { payload: event.delta },
              }));
            }
          }
        });

        xaiWs.on("close", () => {
          console.log("xAI connection closed");
        });

        xaiWs.on("error", (err) => {
          console.error("xAI error:", err.message);
          closeXaiConnection(xaiWs, "closed after error");
          xaiWs = null;
        });
        break;

      case "media":
        if (sessionReady && xaiWs?.readyState === WebSocket.OPEN && data.media?.payload) {
          xaiWs.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: data.media.payload,
          }));
        }
        break;

      case "stop":
        console.log("Stream stopped – sending summary to Zapier");

        const fullTranscript = transcript
          .map((t) => `${t.speaker}: ${t.text}`)
          .join("\n");

        sendToZapier({
          patient_name: patientName,
          phone_number: phoneNumber,
          agent_type: agentType,
          discharge_date: dischargeDate,
          timestamp: callStartTime,
          transcript: fullTranscript || "No transcript captured",
          summary: `Call with ${patientName} (${agentType}) completed. See transcript for details.`,
        });

        markCallFinished(callSid, "finished");
        closeXaiConnection(xaiWs, "closed after stop");
        xaiWs = null;
        break;
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio connection closed");
    markCallFinished(callSid, "stream closed");
    closeXaiConnection(xaiWs, "closed after Twilio close");
    xaiWs = null;
  });
});

app.get("/", (req, res) => res.send("xAI ↔ Twilio Outbound Bridge is running"));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Max concurrent calls: ${MAX_CONCURRENT_CALLS}`);
});
