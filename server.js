const express = require("express");

const app = express();

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

app.get("/", (req, res) => {
  res.status(200).send("James Assist is running.");
});

app.post("/intercom/initialize", (req, res) => {
  console.log("Intercom initialize hit");

  const body = req.body || {};

  console.log("Intercom payload keys:", Object.keys(body));

  const conversationId =
    body.conversation?.id ||
    body.context?.conversation_id ||
    body.conversation_id ||
    "Not found yet";

  const teammateName =
    body.admin?.name ||
    body.teammate?.name ||
    body.context?.admin_name ||
    "Not found yet";

  res.status(200).json({
    canvas: {
      content: {
        components: [
          {
            type: "text",
            text: "James Assist",
            style: "header"
          },
          {
            type: "text",
            text: "FRT Radar: Test mode"
          },
          {
            type: "text",
            text: "Status: Connected safely. Read-only mode is active."
          },
          {
            type: "text",
            text: `Conversation ID: ${conversationId}`
          },
          {
            type: "text",
            text: `Teammate: ${teammateName}`
          },
          {
            type: "text",
            text: "Next step: use this conversation ID to fetch Intercom conversation details and calculate FRT risk."
          }
        ]
      }
    }
  });
});

app.post("/intercom/submit", (req, res) => {
  console.log("Intercom submit hit");

  res.status(200).json({
    canvas: {
      content: {
        components: [
          {
            type: "text",
            text: "James Assist",
            style: "header"
          },
          {
            type: "text",
            text: "Submit route is working safely."
          }
        ]
      }
    }
  });
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`James Assist running on port ${port}`);
});
