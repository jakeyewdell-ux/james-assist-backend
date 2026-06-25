const express = require("express");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  res.send("James Assist is running.");
});

app.post("/intercom/initialize", (req, res) => {
  res.json({
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
            text: "This panel is working. Next step: connect Intercom conversation data."
          },
          {
            type: "button",
            id: "refresh",
            label: "Refresh",
            style: "secondary",
            action: {
              type: "submit"
            }
          }
        ]
      }
    }
  });
});

app.post("/intercom/submit", (req, res) => {
  res.json({
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
            text: "Refresh clicked successfully."
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
