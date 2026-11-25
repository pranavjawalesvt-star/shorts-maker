const json = (status, body) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  try {
    const key = process.env.GROQ_API_KEY;
    if (!key) return json(500, { error: "GROQ_API_KEY is not set in Netlify." });

    const { action, chunks } = JSON.parse(event.body || "{}");
    let messages;

    if (action === "score") {
      const list = chunks
        .map((c) => `[${c.index}] (${Math.round(c.start)}s-${Math.round(c.end)}s) ${c.text}`)
        .join("\n");

      messages = [
        {
          role: "system",
          content: "You are a short-form video editor who spots clips likely to go viral. Reply with JSON only.",
        },
        {
          role: "user",
          content:
            "Rate each transcript excerpt for how likely it is to go viral as a YouTube Short or Reel. " +
            "Consider: a strong hook in the first 3 seconds, emotion or surprise, a complete mini-story, and a clear payoff.\n\n" +
            'Return JSON in this shape: {"clips":[{"index":number,"score":number from 1 to 10,"hook":"the opening line","reason":"one short sentence"}]}\n\n' +
            `Excerpts:\n${list}`,
        },
      ];
    } else if (action === "order") {
      const list = chunks.map((c) => `[${c.index}] ${c.text}`).join("\n");

      messages = [
        {
          role: "system",
          content: "You are a short-form video editor who sequences clips into a story. Reply with JSON only.",
        },
        {
          role: "user",
          content:
            "Put these clips in the best viewing order: a strong hook first, then the body, then a satisfying ending. " +
            'Return JSON in this shape: {"order":[{"index":number,"role":"hook or body or ending","reason":"one short sentence"}]}. ' +
            "Include every index exactly once.\n\n" +
            `Clips:\n${list}`,
        },
      ];
    } else {
      return json(400, { error: "Unknown action" });
    }

    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages,
      }),
    });
    const data = await r.json();
    if (!r.ok) return json(r.status, { error: data.error?.message || "Groq chat error" });

    const parsed = JSON.parse(data.choices[0].message.content);
    return json(200, parsed);
  } catch (e) {
    return json(500, { error: e.message });
  }
};
