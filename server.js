require("dotenv").config();
const express = require("express");
const expressWs = require("express-ws");
const WebSocket = require("ws");
const twilio = require("twilio");
const https = require("https");

const app = express();
expressWs(app);
app.use(express.json());

const PORT = process.env.PORT || 3000;
const XAI_API_KEY = process.env.XAI_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const VERIFIED_CALLER_ID = process.env.VERIFIED_CALLER_ID;
const HOSTNAME = process.env.RENDER_EXTERNAL_URL || process.env.HOSTNAME;
const AGENT_INSTRUCTIONS = process.env.AGENT_INSTRUCTIONS || "You are a helpful assistant.";
const AGENT_VOICE = process.env.AGENT_VOICE || "eve";
const ZAPIER_WEBHOOK_URL = process.env.ZAPIER_WEBHOOK_URL;

if (!XAI_API_KEY || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
  console.error("Missing required environment variables");
  process.exit(1);
}

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Helper to send data to Zapier
function sendToZapier(payload) {
  if (!ZAPIER_WEBHOOK_URL) {
    console.log("No ZAPIER_WEBHOOK_URL set – skipping summary");
    return;
  }

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

    req.on("error", (err) => {
      console.error("Error sending to Zapier:", err.message);
    });

    req.write(data);
    req.end();
  } catch (err) {
    console.error("Failed to send to Zapier:", err.message);
  }
}

// Start outbound call
app.post("/api/call", async (req, res) => {
  try {
    const { to, patient_name } = req.body;

    if (!to || !patient_name) {
      return res.status(400).json({ error: "Missing 'to' or 'patient_name'" });
    }

    const twimlUrl = `${HOSTNAME}/outbound-twiml?patient_name=${encodeURIComponent(patient_name)}&phone_number=${encodeURIComponent(to)}`;

    const call = await twilioClient.calls.create({
      to,
      from: VERIFIED_CALLER_ID || TWILIO_PHONE_NUMBER,
      url: twimlUrl,
      method: "POST",
    });

    console.log(`Call started → ${to} | SID: ${call.sid} | Name: ${patient_name}`);
    res.json({ success: true, callSid: call.sid });
  } catch (err) {
    console.error("Call failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// TwiML that starts the Media Stream
app.post("/outbound-twiml", (req, res) => {
  const patientName = req.query.patient_name || "there";
  const phoneNumber = req.query.phone_number || "";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.get("host")}/media-stream">
      <Parameter name="patient_name" value="${patientName}" />
      <Parameter name="phone_number" value="${phoneNumber}" />
    </Stream>
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// Media Stream ↔ xAI bridge
app.ws("/media-stream", (twilioWs, req) => {
  console.log("Twilio Media Stream connected");

  let streamSid = null;
  let patientName = "there";
  let phoneNumber = "unknown";
  let xaiWs = null;
  let sessionReady = false;
  let transcript = [];
  let callStartTime = new Date().toISOString();

  twilioWs.on("message", (msg) => {
    const data = JSON.parse(msg);

    switch (data.event) {
      case "start":
        streamSid = data.start.streamSid;
        patientName = data.start.customParameters?.patient_name || "there";
        phoneNumber = data.start.customParameters?.phone_number || "unknown";
        console.log(`Stream started | Patient: ${patientName} | Phone: ${phoneNumber}`);

        xaiWs = new WebSocket("wss://api.x.ai/v1/realtime?model=grok-voice-latest", {
          headers: { Authorization: `Bearer ${XAI_API_KEY}` },
        });

        xaiWs.on("open", () => {
          console.log("Connected to xAI Realtime");

          const fullInstructions = `${AGENT_INSTRUCTIONS}

The patient's name is ${patientName}. Always address them by name and confirm you are speaking with them at the beginning of the call.`;

          const sessionUpdate = {
            type: "session.update",
            session: {
              voice: AGENT_VOICE,
              instructions: fullInstructions,
              turn_detection: { type: "server_vad" },
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

        xaiWs.on("message", (xaiMsg) => {
          const event = JSON.parse(xaiMsg.toString());

          console.log("xAI event:", event.type);

          if (event.type === "error") {
            console.error("xAI error details:", JSON.stringify(event, null, 2));
          }

          // Clean transcript collection (final versions only + simple de-dupe)
          if (event.type === "response.output_audio_transcript.done" && event.transcript) {
            const text = event.transcript.trim();
            if (text && (transcript.length === 0 || transcript[transcript.length - 1].text !== text)) {
              transcript.push({ speaker: "Agent", text });
            }
          }

          if (event.type === "conversation.item.input_audio_transcription.completed" && event.transcript) {
            const text = event.transcript.trim();
            if (text && (transcript.length === 0 || transcript[transcript.length - 1].text !== text)) {
              transcript.push({ speaker: "Patient", text });
            }
          }

          // Send audio to Twilio
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

        xaiWs.on("close", (code, reason) => {
          console.log("xAI connection closed. Code:", code, "Reason:", reason?.toString());
        });

        xaiWs.on("error", (err) => {
          console.error("xAI error:", err.message);
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

        const summaryPayload = {
          patient_name: patientName,
          phone_number: phoneNumber,
          timestamp: callStartTime,
          transcript: fullTranscript || "No transcript captured",
          summary: `Call with ${patientName} completed. See transcript for details.`,
        };

        sendToZapier(summaryPayload);

        if (xaiWs) xaiWs.close();
        break;
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio connection closed");
    if (xaiWs) xaiWs.close();
  });
});

app.get("/", (req, res) => res.send("xAI ↔ Twilio Outbound Bridge is running"));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
