require("dotenv").config();
const express = require("express");
const expressWs = require("express-ws");
const WebSocket = require("ws");
const twilio = require("twilio");
const https = require("https");
const http = require("http");

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

