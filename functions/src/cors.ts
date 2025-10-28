import cors from "cors";

// setting allowed origin for each environment

const prodOrigins = ["https://online.cfic.ph"];
const devOrigins = [
  "https://cfc-lg2-dev-01.webflow.io",
  "https://cfc-lg2-dev-02.webflow.io",
];

// Firebase sets this env var automatically
const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;

// Check based on project id
const isProduction = projectId === "cfic-loans-prod";

export const corsHandler = cors({
  origin: (origin, callback) => {
    const allowedOrigins = isProduction ? prodOrigins : devOrigins;
    console.log("CORS check:", { origin, projectId, allowedOrigins });

    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS: " + origin));
    }
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
});
