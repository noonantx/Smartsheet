xaiWs.on("message", (xaiMsg) => {
  const event = JSON.parse(xaiMsg.toString());

  console.log("xAI event:", event.type);   // log every event

  if (event.type === "error") {
    console.error("xAI error event:", JSON.stringify(event, null, 2));
  }

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
