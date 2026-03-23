// import cors from "cors";

// const prodOrigins = ["https://online.cfic.ph"];
// const devOrigins = [
//   "https://cfc-lg2-dev-01.webflow.io",
//   "https://cfc-lg2-dev-02.webflow.io",
// ];

// const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;

// const isProduction = projectId === "cfic-loans-prod";

// export const corsHandler = cors({
//   origin: (origin, callback) => {
//     const allowedOrigins = isProduction ? prodOrigins : devOrigins;
//     console.log("CORS check:", { origin, projectId, allowedOrigins });

//     if (!origin || allowedOrigins.includes(origin)) {
//       callback(null, true);
//     } else {
//       callback(new Error("Not allowed by CORS: " + origin));
//     }
//   },
//   methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
//   allowedHeaders: ["Content-Type", "Authorization"],
//   credentials: true,
// });

import cors from "cors";

const allowedOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "https://cfc-lg2-dev-01.webflow.io",
  "https://cfc-lg2-dev-02.webflow.io",
];

export const corsHandler = cors({
  origin: (origin, callback) => {
    console.log("CORS check:", { origin, allowedOrigins });

    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("Not allowed by CORS: " + origin));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
});
