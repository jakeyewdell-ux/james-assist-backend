const express = require("express");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

app.get("/", (req, res) => {
  res.status(200).send("James Assist is running.");
});

app.post("/intercom/initialize", (req, res) => {
  console.log("Intercom initialize hit");

  res.status(200).json({
    canvas: {
      content: {
        components: [
          {
            type: "text",
            id: "james_assist_title",
            text: "James Assist",
            style: "header"
          },
          {
            type: "text",
            id: "james_assist_status",
            text: "FRT Radar: Test mode"
          },
          {
            type: "text",
            id: "james_assist_message",
            text: "This panel is working. Next step: connect Intercom conversation data."
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
            id: "james_assist_submit_title",
            text: "James Assist",
            style: "header"
          },
          {
            type: "text",
            id: "james_assist_submit_message",
            text: "Submit route is working."
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
