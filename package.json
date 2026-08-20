require("dotenv").config();
const express = require("express");
const expressWs = require("express-ws");
const WebSocket = require("ws");
const twilio = require("twilio");

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

if (!XAI_API_KEY || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
  console.error("Missing required environment variables");
  process.exit(1);
}

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Zapier calls this endpoint
app.post("/api/call", async (req, res) => {
  try {
    const { to, patient_name } = req.body;

    if (!to || !patient_name) {
      return res.status(400).json({ error: "Missing 'to' or 'patient_name'" });
    }

    const twimlUrl = `${HOSTNAME}/outbound-twiml?patient_name=${encodeURIComponent(patient_name)}`;

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

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.get("host")}/media-stream">
      <Parameter name="patient_name" value="${patientName}" />
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
  let xaiWs = null;
  let sessionReady = false;

  twilioWs.on("message", (msg) => {
    const data = JSON.parse(msg);

    switch (data.event) {
      case "start":
        streamSid = data.start.streamSid;
        patientName = data.start.customParameters?.patient_name || "there";
        console.log(`Stream started | Patient: ${patientName}`);

        xaiWs = new WebSocket("wss://api.x.ai/v1/realtime?model=grok-voice-latest", {
          headers: { Authorization: `Bearer ${XAI_API_KEY}` },
        });

        xaiWs.on("open", () => {
          console.log("Connected to xAI Realtime");

          const sessionUpdate = {
            type: "session.update",
            session: {
              voice: process.env.AGENT_VOICE || "eve",
              instructions: `You are speaking with ${patientName}. Address them by name.`,
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
          const event = JSON.parse(xaiMsg);

          if (event.type === "response.audio.delta" && event.delta) {
            if (twilioWs.readyState === WebSocket.OPEN) {
              twilioWs.send(JSON.stringify({
                event: "media",
                streamSid,
                media: { payload: event.delta },
              }));
            }
          }
        });

        xaiWs.on("error", (err) => console.error("xAI error:", err.message));
        xaiWs.on("close", () => console.log("xAI connection closed"));
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
        console.log("Stream stopped");
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