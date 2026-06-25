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

  res.status(200).json({
    canvas: {
      content: {
        components: [
          {
            type: "text",
            text: "James Assist is connected."
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
