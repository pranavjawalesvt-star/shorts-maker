const json = (status, body) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  try {
    const key = process.env.GROQ_API_KEY;
    if (!key) return json(500, { error: "GROQ_API_KEY is not set in Netlify." });

    const buf = Buffer.from(event.body || "", event.isBase64Encoded ? "base64" : "utf8");

    const form = new FormData();
    form.append("file", new Blob([buf], { type: "audio/mpeg" }), "audio.mp3");
    form.append("model", "whisper-large-v3-turbo");
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");

    const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    const data = await r.json();
    if (!r.ok) return json(r.status, { error: data.error?.message || "Groq transcription error" });

    const segments = (data.segments || []).map((s) => ({
      start: s.start,
      end: s.end,
      text: s.text.trim(),
    }));
    return json(200, { segments });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
