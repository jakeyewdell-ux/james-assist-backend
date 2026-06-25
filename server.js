const express = require("express");

const app = express();

// Important: Intercom can send a large payload to Canvas Kit.
// The 10mb limit prevents "PayloadTooLargeError".
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Basic request logging for Render logs.
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// Health check route.
// Open https://james-assist-backend.onrender.com to test this.
app.get("/", (req, res) => {
  res.status(200).send("James Assist is running.");
});

// Intercom Canvas Kit initialize route.
// This loads when James Assist appears inside the Intercom teammate sidebar.
app.post("/intercom/initialize", (req, res) => {
  console.log("Intercom initialize hit");

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
            text: "Next step: connect Intercom conversation data so this can calculate FRT risk."
          }
        ]
      }
    }
  });
});

// Intercom Canvas Kit submit route.
// We are keeping this safe and read-only for now.
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

// Render provides process.env.PORT.
// Local fallback is 3000.
const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`James Assist running on port ${port}`);
});
