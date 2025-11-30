import { onRequest } from "firebase-functions/v2/https";

import * as admin from "firebase-admin";
// import cors from "cors";
import { corsHandler } from "./cors";
import { drive_v3, google } from "googleapis";
import * as stream from "stream";
import Busboy from "busboy";
import { getStorage } from "firebase-admin/storage";
// import { onDocumentWritten } from "firebase-functions/v2/firestore";
// import { FieldValue } from "firebase-admin/firestore";

admin.initializeApp();

// const corsHandler = cors({ origin: true });
const googleSheetId = "1EqUEyA_wkuZqhND5ouxcow-0SOnW4hHLFvfs9j-98Ps";
const googleDriveId = "1aUNgjYlAeegqvVMgxEsF9NSTxcz1rO67";
const db = admin.firestore();
const storage = getStorage();
// const BATCH_SIZE = 500;

// async function batchWrite(
//   collectionRef: FirebaseFirestore.CollectionReference,
//   docs: { id: string; data: any }[]
// ) {
//   let batch = db.batch();
//   let count = 0;

//   for (const doc of docs) {
//     const docRef = collectionRef.doc(doc.id);
//     batch.set(docRef, doc.data);
//     count++;
//     if (count === BATCH_SIZE) {
//       await batch.commit();
//       batch = db.batch();
//       count = 0;
//     }
//   }
//   if (count > 0) {
//     await batch.commit();
//   }
// }

export const importPSGC = onRequest(
  {
    memory: "1GiB",
    timeoutSeconds: 540, // max allowed for 2nd gen
  },
  async (req, res) => {
    try {
      console.log("Starting import…");

      const provincesRes = await fetch(
        "https://psgc.gitlab.io/api/provinces.json"
      );
      const provinces = await provincesRes.json();

      for (const province of provinces) {
        console.log(`Importing province: ${province.name}`);
        const provinceRef = db.collection("provinces").doc(province.code);
        await provinceRef.set({ name: province.name });

        // Fetch cities/municipalities
        const citiesRes = await fetch(
          `https://psgc.gitlab.io/api/provinces/${province.code}/cities-municipalities.json`
        );
        const cities = await citiesRes.json();

        for (const city of cities) {
          console.log(` → City: ${city.name}`);
          const cityRef = provinceRef.collection("cities").doc(city.code);
          await cityRef.set({ name: city.name });

          // Fetch barangays
          const barangaysRes = await fetch(
            `https://psgc.gitlab.io/api/cities-municipalities/${city.code}/barangays.json`
          );
          const barangays = await barangaysRes.json();

          // Write barangays in chunks of 500 (Firestore limit)
          let batch = db.batch();
          let batchCounter = 0;

          for (const brgy of barangays) {
            const brgyRef = cityRef.collection("barangays").doc(brgy.code);
            batch.set(brgyRef, { name: brgy.name });
            batchCounter++;

            if (batchCounter === 500) {
              await batch.commit();
              batch = db.batch();
              batchCounter = 0;
            }
          }

          // commit remaining
          if (batchCounter > 0) await batch.commit();
        }
      }

      console.log("Import finished successfully");
      res.status(200).send({ message: "PSGC data imported successfully!" });
    } catch (err: unknown) {
      console.error("Import FAILED:", err);
      res.status(500).send({
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }
);

export const importPSGCinCloudStorage = onRequest(async (req, res) => {
  try {
    const bucket = storage.bucket();
    const file = bucket.file("psgc-all.json");
    const contents = await file.download();
    const data = JSON.parse(contents[0].toString());

    console.log("Starting import...");

    for (const province of data) {
      await db.collection("psgc_provinces").doc(province.code).set(province);
      console.log(`Imported province ${province.name}`);
    }

    res.status(200).send({ message: "PSGC import completed" });
  } catch (err) {
    console.error("Error importing PSGC:", err);
    res
      .status(500)
      .send({ error: err instanceof Error ? err.message : "Unknown" });
  }
});

export const registerUser = onRequest((req, res) => {
  corsHandler(req, res, async (err: any) => {
    if (err) {
      console.error("CORS error:", err);
      res.status(403).send("CORS blocked this request");
      return;
    }

    // ✅ Handle preflight requests early
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    try {
      const { email, password, firstname, lastname, middlename } = req.body;

      if (!email || !password) {
        res.status(400).send({ message: "Email and password are required" });
        return;
      }

      // check if user exists
      try {
        await admin.auth().getUserByEmail(email);
        res.status(400).send({ message: "Email already exists" });
        return;
      } catch (err: any) {
        if (err.code !== "auth/user-not-found") {
          res
            .status(500)
            .send({ message: "Internal error checking user", error: err });
          return;
        }
      }

      // generate OTP
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = Date.now() + 5 * 60 * 1000;

      await admin.firestore().collection("pending_user").doc(email).set({
        email,
        password,
        otp,
        firstname,
        lastname,
        middlename,
        expiresAt,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // trigger email extension
      await admin
        .firestore()
        .collection("mail")
        .add({
          to: email,
          message: {
            subject: "Your OTP code",
            html: `<p>Your OTP is <strong>${otp}</strong></p>`,
          },
        });

      res.status(201).send({ message: "OTP sent to your email" });
    } catch (error: unknown) {
      console.error("Error creating user or sending OTP:", error);
      res.status(500).send({
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      });
    }
  });
});
export const verifyOTP = onRequest((req, res) => {
  corsHandler(req, res, async (err: any) => {
    if (err) {
      console.error("CORS error:", err);
      res.status(403).send({ message: "CORS blocked this request" });
      return;
    }

    // ✅ Preflight request
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    try {
      const { email, otp } = req.body;

      if (!email || !otp) {
        res.status(400).send({ message: "Email and OTP are required" });
        return;
      }

      const pendingUserRef = admin
        .firestore()
        .collection("pending_user")
        .doc(email);
      const pendingUserDoc = await pendingUserRef.get();

      if (!pendingUserDoc.exists) {
        res.status(400).send({ message: "User not found or not registered" });
        return;
      }

      const pendingUserData = pendingUserDoc.data();

      if (pendingUserData?.otp !== otp) {
        res.status(400).send({ message: "Invalid OTP" });
        return;
      }

      if (Date.now() > pendingUserData?.expiresAt) {
        res.status(400).send({ message: "OTP has expired" });
        return;
      }

      // Create user in Firebase Auth
      const userRecord = await admin.auth().createUser({
        email: pendingUserData?.email,
        password: pendingUserData?.password,
        displayName: `${pendingUserData?.firstname} ${
          pendingUserData?.lastname
        } ${pendingUserData?.middlename || ""}`.trim(),
      });

      // Save user in Firestore (permanent users collection)
      await admin.firestore().collection("users").doc(userRecord.uid).set({
        email: pendingUserData?.email,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Remove temporary pending user record
      await pendingUserRef.delete();

      // Generate Firebase custom token
      const customToken = await admin.auth().createCustomToken(userRecord.uid);

      res.status(200).send({
        message: "Successfully Registered",
        token: customToken,
      });
    } catch (error: unknown) {
      console.error("Error in verifyOTP:", error);
      res.status(500).send({
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      });
    }
  });
});

// export const uploadToDriveWithForm = onRequest(
//   { secrets: ["GOOGLE_SERVICE_ACCOUNT"] },
//   (req, res): Promise<void> => {
//     return new Promise<void>((resolve, reject) => {
//       corsHandler(req, res, async () => {
//         try {
//           if (req.method === "OPTIONS") {
//             res.set("Access-Control-Allow-Origin", "*");
//             res.set("Access-Control-Allow-Methods", "POST");
//             res.set(
//               "Access-Control-Allow-Headers",
//               "Content-Type, Authorization"
//             );
//             res.status(204).send("");
//             return resolve();
//           }

//           if (req.method !== "POST") {
//             res.status(405).send("Method Not Allowed");
//             return resolve();
//           }

//           const idToken = req.headers.authorization?.split("Bearer ")[1];
//           if (!idToken) {
//             res.set("Access-Control-Allow-Origin", "*");
//             res
//               .status(401)
//               .json({ success: false, error: "No ID token provided" });
//             return reject("No ID token");
//           }

//           let uid: string;
//           let decoded: any;
//           try {
//             const decodedToken = await admin.auth().verifyIdToken(idToken);
//             decoded = decodedToken;
//             uid = decodedToken.uid;
//           } catch (error) {
//             res.set("Access-Control-Allow-Origin", "*");
//             res.status(401).json({ success: false, error: "Invalid ID token" });
//             return reject("Invalid ID token");
//           }

//           const FOLDER_ID = "1aUNgjYlAeegqvVMgxEsF9NSTxcz1rO67";
//           const serviceAccount = JSON.parse(
//             process.env.GOOGLE_SERVICE_ACCOUNT!
//           );

//           const auth = new google.auth.GoogleAuth({
//             credentials: {
//               client_email: serviceAccount.client_email,
//               private_key: serviceAccount.private_key,
//             },
//             scopes: [
//               "https://www.googleapis.com/auth/drive.file",
//               "https://www.googleapis.com/auth/spreadsheets",
//             ],
//           });

//           const drive = google.drive({ version: "v3", auth });
//           const sheets = google.sheets({ version: "v4", auth });
//           const busboy = Busboy({ headers: req.headers });

//           const fields: Record<string, string> = {};
//           const uploadedFiles: {
//             buffer: Buffer[];
//             name: string;
//             mimeType: string;
//             field: string;
//           }[] = [];

//           busboy.on("field", (fieldname, value) => {
//             fields[fieldname] = value;
//           });

//           busboy.on("file", (_fieldname, file, info) => {
//             const fileData = {
//               buffer: [] as Buffer[],
//               name: info.filename,
//               mimeType: info.mimeType || "application/octet-stream",
//               field: _fieldname,
//             };
//             file.on("data", (data: Buffer) => fileData.buffer.push(data));
//             file.on("end", () => uploadedFiles.push(fileData));
//           });

//           busboy.on("finish", async () => {
//             try {
//               if (uploadedFiles.length === 0) {
//                 throw new Error("No files uploaded.");
//               }

//               const capitalize = (s: string) => s.trim().toUpperCase();
//               const newFolderName = `${capitalize(
//                 fields.lastname || ""
//               )}, ${capitalize(fields.firstname || "")}`;

//               let applicantFolderId: string | null = null;
//               const existDoc = await admin
//                 .firestore()
//                 .collection("applicants")
//                 .doc(uid)
//                 .get();

//               if (existDoc.exists) {
//                 const existingData = existDoc.data();

//                 if (existingData?.folderId) {
//                   try {
//                     const result = await drive.files.get({
//                       fileId: existingData.folderId,
//                       fields: "id",
//                       supportsAllDrives: true,
//                     });

//                     applicantFolderId = result.data.id!;

//                     const nameChanged =
//                       existingData.lastname?.toUpperCase() !==
//                         (fields.lastname || "").toUpperCase() ||
//                       existingData.firstname?.toUpperCase() !==
//                         (fields.firstname || "").toUpperCase();

//                     if (nameChanged && applicantFolderId) {
//                       await drive.files.update({
//                         fileId: applicantFolderId,
//                         requestBody: { name: newFolderName },
//                         supportsAllDrives: true,
//                       });
//                     }
//                   } catch (e) {
//                     console.warn(
//                       "⚠️ Stored folderId is invalid or deleted. Creating new."
//                     );
//                     applicantFolderId = null;
//                   }
//                 }
//               }

//               if (!applicantFolderId) {
//                 const folderMetadata = {
//                   name: newFolderName,
//                   mimeType: "application/vnd.google-apps.folder",
//                   parents: [FOLDER_ID],
//                 };

//                 const folderResult = await drive.files.create({
//                   requestBody: folderMetadata,
//                   fields: "id",
//                   supportsAllDrives: true,
//                 });

//                 applicantFolderId = folderResult.data.id!;
//                 console.log("📁 Created new Drive folder:", applicantFolderId);
//               }

//               const uploadedDriveFiles: drive_v3.Schema$File[] = [];

//               for (const file of uploadedFiles) {
//                 const media = {
//                   mimeType: file.mimeType,
//                   body: stream.Readable.from(Buffer.concat(file.buffer)),
//                 };

//                 const fileMetadata = {
//                   name: `${file.field}-${file.name}`,
//                   parents: [applicantFolderId],
//                 };

//                 const fileResult = await drive.files.create({
//                   requestBody: fileMetadata,
//                   media,
//                   fields: "id, name, webViewLink",
//                   supportsAllDrives: true,
//                 });

//                 uploadedDriveFiles.push(fileResult.data);
//               }

//               const formData = {
//                 ...fields,
//                 folderId: applicantFolderId,
//               };

//               await admin
//                 .firestore()
//                 .collection("applicants")
//                 .doc(uid)
//                 .set(formData, { merge: true });

//               const emailHtml = `
//                 <div style="font-family: Arial; padding: 20px;">
//                   <h2>Thank you for your application</h2>
//                     ${renderFormDataHtmlList(formData)}
//                   <p style="color: #999;">— CFIC Team</p>
//                 </div>
//               `;

//               const emailToUserHtml = `
//                 <div style="font-family: Arial; padding: 20px;">
//                   <h2>New Application!</h2>
//                   <p>Here's a summary of your submission:</p>
//                   ${renderFormDataHtmlList(formData)}
//                     <p><strong>Google Drive Folder:</strong>
//                       <a href="https://drive.google.com/drive/folders/${applicantFolderId}" target="_blank">View Files</a>
//                     </p>
//                   <p style="color: #999;">— CFIC Team</p>
//                 </div>
//               `;

//               const emailToUserUpdateHtml = `
//                 <div style="font-family: Arial; padding: 20px;">
//                   <h2>Application has been updated</h2>
//                   <p>Here's a summary of your submission:</p>
//                   ${renderFormDataHtmlList(formData)}
//                     <p><strong>Google Drive Folder:</strong>
//                       <a href="https://drive.google.com/drive/folders/${applicantFolderId}" target="_blank">View Files</a>
//                     </p>
//                   <p style="color: #999;">— CFIC Team</p>
//                 </div>
//               `;

//               const subject = `CFIC-${fields.lastname},${fields.firstname}`;

//               const toSend = decoded.email || fields.email;
//               if (!toSend) {
//                 res.status(400).json({
//                   success: false,
//                   error: "Missing email to send summary",
//                 });
//                 return reject("Missing applicant email");
//               }

//               // ✅ Send summary to applicant
//               await admin
//                 .firestore()
//                 .collection("mail")
//                 .add({
//                   to: toSend,
//                   message: {
//                     subject: "Your Application Summary",
//                     html: emailHtml,
//                     from: "noreply@cfic.ph",
//                   },
//                 });

//               // ✅ Send admin notification

//               if (existDoc.exists) {
//                 await admin
//                   .firestore()
//                   .collection("mail")
//                   .add({
//                     to: "online@cfic.ph",
//                     message: {
//                       subject: subject,
//                       html: emailToUserUpdateHtml,
//                       from: toSend,
//                     },
//                   });
//               } else {
//                 await admin
//                   .firestore()
//                   .collection("mail")
//                   .add({
//                     to: "online@cfic.ph",
//                     message: {
//                       subject: subject,
//                       html: emailToUserHtml,
//                       from: toSend,
//                     },
//                   });
//               }
//               try {
//                 const SHEET_ID = googleSheetId;

//                 // 🧠 STEP 1: parse and flatten all fields dynamically
//                 for (const key in fields) {
//                   try {
//                     const parsed = JSON.parse(fields[key]);
//                     if (typeof parsed === "object" && parsed !== null)
//                       fields[key] = parsed;
//                   } catch {
//                     // not JSON, ignore
//                   }
//                 }

//                 const flatFields = flattenObject(fields);

//                 // 🧠 STEP 2: get existing headers
//                 const existing = await sheets.spreadsheets.values.get({
//                   spreadsheetId: SHEET_ID,
//                   range: "Sheet1!1:1", // header row
//                 });

//                 let existingHeaders: string[] = [];
//                 if (existing.data.values && existing.data.values.length > 0) {
//                   existingHeaders = existing.data.values[0];
//                 }

//                 // 🧠 STEP 3: auto-generate missing headers
//                 const newKeys = Object.keys(flatFields).filter(
//                   (key) => !existingHeaders.includes(key)
//                 );
//                 if (!existingHeaders.includes("Timestamp"))
//                   existingHeaders.unshift("Timestamp");
//                 if (!existingHeaders.includes("Uploaded Files"))
//                   existingHeaders.push("Uploaded Files");

//                 if (newKeys.length > 0) {
//                   const updatedHeaders = [...existingHeaders, ...newKeys];
//                   await sheets.spreadsheets.values.update({
//                     spreadsheetId: SHEET_ID,
//                     range: "Sheet1!1:1",
//                     valueInputOption: "USER_ENTERED",
//                     requestBody: { values: [updatedHeaders] },
//                   });
//                   existingHeaders = updatedHeaders;
//                 }

//                 // 🧠 STEP 4: order data according to headers
//                 const rowData = existingHeaders.map((header) => {
//                   if (header === "Timestamp") return new Date().toISOString();
//                   if (header === "Uploaded Files")
//                     return uploadedDriveFiles.map((f) => f.name).join(", ");
//                   return flatFields[header] ?? "";
//                 });

//                 // 🧠 STEP 5: append the new row
//                 await sheets.spreadsheets.values.append({
//                   spreadsheetId: SHEET_ID,
//                   range: "Sheet1",
//                   valueInputOption: "USER_ENTERED",
//                   requestBody: { values: [rowData] },
//                 });

//                 console.log("✅ Data successfully appended to Google Sheet");
//               } catch (sheetErr) {
//                 console.warn("⚠️ Failed to log to Google Sheets:", sheetErr);
//               }
//               res.set("Access-Control-Allow-Origin", "*");
//               res.status(200).json({
//                 success: true,
//                 uploadedFiles: uploadedDriveFiles,
//                 fields: formData,
//                 timestamp: new Date().toISOString(),
//               });

//               return resolve();
//             } catch (err: any) {
//               console.error("🔥 Upload or Firestore failed:", err);
//               res.set("Access-Control-Allow-Origin", "*");
//               res.status(500).json({
//                 success: false,
//                 error: err.message || err.toString(),
//               });
//               return reject(err);
//             }
//           });

//           busboy.on("error", (err: Error) => {
//             console.error("📛 Busboy error:", err);
//             res.set("Access-Control-Allow-Origin", "*");
//             res.status(500).json({ success: false, error: err.message });
//             reject(err);
//           });

//           busboy.end(req.rawBody);
//         } catch (err: any) {
//           console.error("💥 Unexpected server error:", err);
//           res.set("Access-Control-Allow-Origin", "*");
//           res
//             .status(500)
//             .json({ success: false, error: err.message || err.toString() });
//           reject(err);
//         }
//       });
//     });
//   }
// );

/// helper functions

export const uploadToDriveWithForm = onRequest(
  { secrets: ["GOOGLE_SERVICE_ACCOUNT"], minInstances: 1 },
  (req, res): Promise<void> => {
    return new Promise<void>((resolve) => {
      corsHandler(req, res, async () => {
        try {
          if (req.method === "OPTIONS") {
            res.set("Access-Control-Allow-Origin", "*");
            res.set("Access-Control-Allow-Methods", "POST");
            res.set(
              "Access-Control-Allow-Headers",
              "Content-Type, Authorization"
            );
            res.status(204).send("");
            return resolve();
          }

          if (req.method !== "POST") {
            res.status(405).send("Method Not Allowed");
            return resolve();
          }

          const idToken = req.headers.authorization?.split("Bearer ")[1];
          if (!idToken) {
            res.set("Access-Control-Allow-Origin", "*");
            res
              .status(401)
              .json({ success: false, error: "No ID token provided" });
            return resolve();
          }

          let uid: string;
          let decoded: any;
          try {
            const decodedToken = await admin.auth().verifyIdToken(idToken);
            decoded = decodedToken;
            uid = decodedToken.uid;
          } catch {
            res.set("Access-Control-Allow-Origin", "*");
            res.status(401).json({ success: false, error: "Invalid ID token" });
            return resolve();
          }

          // Prepare Google API clients
          const serviceAccount = JSON.parse(
            process.env.GOOGLE_SERVICE_ACCOUNT!
          );
          const auth = new google.auth.GoogleAuth({
            credentials: {
              client_email: serviceAccount.client_email,
              private_key: serviceAccount.private_key,
            },
            scopes: [
              "https://www.googleapis.com/auth/drive.file",
              "https://www.googleapis.com/auth/spreadsheets",
            ],
          });

          const drive = google.drive({ version: "v3", auth });
          const sheets = google.sheets({ version: "v4", auth });
          const FOLDER_ID = googleDriveId;
          const SHEET_ID = googleSheetId;

          const busboy = Busboy({ headers: req.headers });
          const fields: Record<string, string> = {};
          const uploadedFiles: {
            buffer: Buffer[];
            name: string;
            mimeType: string;
            field: string;
          }[] = [];

          // Parse form data
          busboy.on("field", (fieldname, value) => (fields[fieldname] = value));

          busboy.on("file", (_fieldname, file, info) => {
            const fileData = {
              buffer: [] as Buffer[],
              name: info.filename,
              mimeType: info.mimeType || "application/octet-stream",
              field: _fieldname,
            };
            file.on("data", (data: Buffer) => fileData.buffer.push(data));
            file.on("end", () => uploadedFiles.push(fileData));
          });

          busboy.on("finish", async () => {
            // ✅ Respond IMMEDIATELY to frontend for better UX
            res.set("Access-Control-Allow-Origin", "*");
            res
              .status(200)
              .json({ success: true, message: "Form received successfully" });
            resolve();

            // Continue processing in the background
            (async () => {
              try {
                const capitalize = (s: string) => s.trim().toUpperCase();
                const newFolderName = `${capitalize(
                  fields.lastname || ""
                )}, ${capitalize(fields.firstname || "")}`;

                // Check if applicant already has a folder
                const existDoc = await admin
                  .firestore()
                  .collection("applicants")
                  .doc(uid)
                  .get();
                let applicantFolderId: string | null = null;

                if (existDoc.exists && existDoc.data()?.folderId) {
                  try {
                    await drive.files.get({
                      fileId: existDoc.data()?.folderId,
                      fields: "id",
                      supportsAllDrives: true,
                    });
                    applicantFolderId = existDoc.data()?.folderId;
                  } catch {
                    applicantFolderId = null;
                  }
                }

                // Create folder if missing
                if (!applicantFolderId) {
                  const folderResult = await drive.files.create({
                    requestBody: {
                      name: newFolderName,
                      mimeType: "application/vnd.google-apps.folder",
                      parents: [FOLDER_ID],
                    },
                    fields: "id",
                    supportsAllDrives: true,
                  });
                  applicantFolderId = folderResult.data.id!;
                }

                // Upload files to Drive
                const uploadedDriveFiles: drive_v3.Schema$File[] = [];
                for (const file of uploadedFiles) {
                  const media = {
                    mimeType: file.mimeType,
                    body: stream.Readable.from(Buffer.concat(file.buffer)),
                  };
                  const fileResult = await drive.files.create({
                    requestBody: {
                      name: `${file.field}-${file.name}`,
                      parents: [applicantFolderId],
                    },
                    media,
                    fields: "id, name, webViewLink",
                    supportsAllDrives: true,
                  });
                  uploadedDriveFiles.push(fileResult.data);
                }

                // Save form + folderId to Firestore
                const cleandedForm = cleanFormData(fields);
                // const formData = { ...fields, folderId: applicantFolderId };
                await admin
                  .firestore()
                  .collection("applicants")
                  .doc(uid)
                  .set(
                    {
                      ...cleandedForm,
                      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    },
                    { merge: true }
                  );

                // Prepare emails
                // ✅ Email subject (safely handles missing names)
                const firstname =
                  cleandedForm.personalInfo?.firstname ||
                  fields.firstname ||
                  "";
                const lastname =
                  cleandedForm.personalInfo?.lastname || fields.lastname || "";
                const subject = `CFIC - ${lastname}, ${firstname}`;
                // ✅ Email body for applicant
                const emailHtml = `
  <div style="font-family: Arial, sans-serif; padding: 24px; background-color: #f8f9fa; color: #333;">
    <h2 style="color: #2a2a2a;">Thank you for your application</h2>
    <p style="margin-bottom: 20px;">We’ve received your loan application. Below are your details:</p>
    ${renderFormDataHtmlList(cleandedForm)}
    <p style="margin-top: 30px; color: #999;">— CFIC Team</p>
  </div>`;

                // ✅ Email body for admin
                const adminEmailHtml = `
  <div style="font-family: Arial, sans-serif; padding: 24px; background-color: #f8f9fa; color: #333;">
    <h2 style="color: #2a2a2a;">New Application Received!</h2>
    ${renderFormDataHtmlList(cleandedForm)}
    <p style="margin-top: 20px;">
      <strong>📂 Folder:</strong> 
      <a href="https://drive.google.com/drive/folders/${applicantFolderId}" 
         target="_blank" 
         style="color:#1a73e8; text-decoration:none;">View Files</a>
    </p>
  </div>`;
                const toSend = decoded.email || fields.email;

                // Send emails via Firestore-triggered mail
                await admin
                  .firestore()
                  .collection("mail")
                  .add({
                    to: toSend,
                    message: {
                      subject: "Your Application Summary",
                      html: emailHtml,
                      from: "noreply@cfic.ph",
                    },
                  });

                await admin
                  .firestore()
                  .collection("mail")
                  .add({
                    to: "online@cfic.ph",
                    message: {
                      subject,
                      html: adminEmailHtml,
                      from: toSend,
                    },
                  });

                // Log to Google Sheets
                try {
                  for (const key in fields) {
                    try {
                      const parsed = JSON.parse(fields[key]);
                      if (typeof parsed === "object") fields[key] = parsed;
                    } catch {}
                  }
                  const flatFields = flattenObject(fields);

                  // Get existing headers
                  const existing = await sheets.spreadsheets.values.get({
                    spreadsheetId: SHEET_ID,
                    range: "Sheet1!1:1",
                  });
                  let headers: string[] = existing.data.values?.[0] || [
                    "Timestamp",
                    "Uploaded Files",
                  ];

                  // Add missing headers
                  const newKeys = Object.keys(flatFields).filter(
                    (k) => !headers.includes(k)
                  );
                  if (newKeys.length > 0) {
                    headers = [...headers, ...newKeys];
                    await sheets.spreadsheets.values.update({
                      spreadsheetId: SHEET_ID,
                      range: "Sheet1!1:1",
                      valueInputOption: "USER_ENTERED",
                      requestBody: { values: [headers] },
                    });
                  }

                  // Append new row
                  const row = headers.map((h) => {
                    if (h === "Timestamp") return new Date().toISOString();
                    if (h === "Uploaded Files")
                      return uploadedDriveFiles.map((f) => f.name).join(", ");
                    return flatFields[h] ?? "";
                  });

                  await sheets.spreadsheets.values.append({
                    spreadsheetId: SHEET_ID,
                    range: "Sheet1",
                    valueInputOption: "USER_ENTERED",
                    requestBody: { values: [row] },
                  });
                } catch (sheetErr: any) {
                  console.warn("⚠️ Google Sheets failed:", sheetErr);
                  await admin
                    .firestore()
                    .collection("mail")
                    .add({
                      to: "dev@cfic.ph",
                      message: {
                        subject: "Google Sheets Logging Failed",
                        html: `<p>${sheetErr.message}</p>`,
                        from: "noreply@cfic.ph",
                      },
                    });
                }
              } catch (err: any) {
                console.error("🔥 Background error:", err);
                await admin
                  .firestore()
                  .collection("mail")
                  .add({
                    to: "dev@cfic.ph",
                    message: {
                      subject: "Form Processing Failed",
                      html: `<pre>${err.message || err}</pre>`,
                      from: "noreply@cfic.ph",
                    },
                  });
              }
            })();
          });

          busboy.end(req.rawBody);
        } catch (err: any) {
          console.error("💥 Unexpected error:", err);
          res.set("Access-Control-Allow-Origin", "*");
          res.status(500).json({ success: false, error: err.message });
          resolve();
        }
      });
    });
  }
);

export const getProvinces = onRequest((req, res) => {
  corsHandler(req, res, async (err) => {
    if (err) return res.status(403).send("Cors Blocked");
    if (req.method === "OPTIONS") return res.status(204).send("");

    try {
      const snapshot = await db.collection("psgc_provinces").get();
      const provinces = snapshot.docs.map((doc) => ({
        code: doc.id,
        name: doc.data().name,
      }));

      // 🔥 Add NCR pseudo-province if not already included
      if (!provinces.find((p) => p.code === "NCR")) {
        provinces.push({ code: "NCR", name: "National Capital Region (NCR)" });
      }
      provinces.sort((a, b) => a.name.localeCompare(b.name));
      return res.status(200).json(provinces);
    } catch (error) {
      return res.status(500).send({
        error: error instanceof Error ? error.message : "Unknown",
      });
    }
  });
});

export const getCities = onRequest(async (req, res) => {
  corsHandler(req, res, async (err) => {
    if (err) return res.status(403).send("Cors Blocked");
    if (req.method === "OPTIONS") return res.status(204).send("");

    const provinceCode = req.query.provinceCode as string | undefined;

    if (!provinceCode) {
      res.status(400).json({ error: "provinceCode is required" });
      return;
    }

    try {
      const provinceSnapshot = await admin
        .firestore()
        .collection("psgc_provinces")
        .get();
      let cities: { code: string; name: string }[] = [];

      for (const doc of provinceSnapshot.docs) {
        const provinceData = doc.data() as {
          code: string;
          cities?: {
            code: string;
            name: string;
            barangays?: { code: string; name: string }[];
          }[];
        };

        const provinceMatch = provinceData.code === provinceCode;
        if (provinceMatch && provinceData.cities) {
          cities = provinceData.cities.map((c) => ({
            code: c.code,
            name: c.name,
          }));
          break;
        }
      }

      if (!cities.length) {
        res.status(404).json({ error: "Province not found" });
        return;
      }

      return res
        .status(200)
        .json(
          cities.sort((a: { name: string }, b: { name: string }) =>
            a.name.localeCompare(b.name)
          )
        );
    } catch (error) {
      console.error("❌ getCities error:", error);
      return res
        .status(500)
        .json({ error: error instanceof Error ? error.message : "Unknown" });
    }
  });
});

export const getBarangays = onRequest((req, res) => {
  corsHandler(req, res, async (err) => {
    if (err) return res.status(403).send("CORS blocked this request");
    if (req.method === "OPTIONS") return res.status(204).send("");
    const cityCode = req.query.cityCode as string;
    if (!cityCode)
      return res.status(400).json({ error: "cityCode is required" });

    try {
      // Search all provinces to find the city
      const provinceSnapshot = await admin
        .firestore()
        .collection("psgc_provinces")
        .get();
      let barangays: { code: string; name: string }[] = [];

      for (const doc of provinceSnapshot.docs) {
        const provinceData = doc.data() as {
          cities?: {
            code: string;
            name: string;
            barangays?: { code: string; name: string }[];
          }[];
        };

        const city = provinceData.cities?.find((c) => c.code === cityCode);
        if (city) {
          barangays = city.barangays || [];
          break;
        }
      }

      if (!barangays.length)
        return res.status(404).json({ error: "City not found" });

      return res
        .status(200)
        .json(barangays.sort((a, b) => a.name.localeCompare(b.name)));
    } catch (error) {
      console.error("❌ getBarangays error:", error);
      return res
        .status(500)
        .json({ error: error instanceof Error ? error.message : "Unknown" });
    }
  });
});

// function renderFormDataHtmlList(data: any, indent = 0): string {
//   let html = '<ul style="list-style: none; padding: 0; margin: 20px 0;">';

//   for (const [key, value] of Object.entries(data)) {
//     if (typeof value === "object" && value !== null && !Array.isArray(value)) {
//       html += `<li style="padding: 10px 0; border-bottom: 1px solid #eaeaea;">
//         <div style="font-weight: bold; color: #333;">${key}</div>
//         ${renderFormDataHtmlList(value, indent + 1)}
//       </li>`;
//     } else {
//       html += `<li style="padding: 10px 0; border-bottom: 1px solid #eaeaea;">
//         <span style="font-weight: bold; display: inline-block; width: 140px; color: #333;">${key}:</span>
//         <span style="color: #555;">${value ?? ""}</span>
//       </li>`;
//     }
//   }

//   html += "</ul>";
//   return html;
// }

// 🧹 Clean and structure form data before saving to Firestore
function cleanFormData(rawData: Record<string, any>): Record<string, any> {
  const excludeKeys = [
    "cf-turnstile-response",
    "Accept-privacy-policy",
    "field-3",
    "folderId", // we'll attach manually below
  ];

  const cleaned: Record<string, any> = {};

  for (const [key, value] of Object.entries(rawData)) {
    if (excludeKeys.includes(key)) continue;
    if (value === "" || value == null) continue;

    try {
      // Parse JSON if it's a valid stringified object
      const parsed = JSON.parse(value as string);
      cleaned[key] = parsed;
    } catch {
      cleaned[key] = value;
    }
  }

  return cleaned;
}

function renderFormDataHtmlList(formData: any) {
  const p = formData.personalInfo || {};
  const l = formData.loanInfo || {};
  const c = formData.coMakerInfo || {};

  return `
    <table style="width:100%; border-collapse:collapse; font-family:Arial;">
      <tbody>
        <tr><td><b>Full Name</b></td><td>${p.firstname || ""} ${
    p.lastname || ""
  }</td></tr>
        <tr><td><b>Email</b></td><td>${p.email || ""}</td></tr>
        <tr><td><b>Contact No.</b></td><td>${
          p.contactInfo?.mobileNumber || ""
        }</td></tr>
        <tr><td><b>Address</b></td><td>${
          p.currentAddress?.currentFullAddress || ""
        }</td></tr>
        <tr><td><b>Loan Amount</b></td><td>${l.loanAmount || ""}</td></tr>
        <tr><td><b>Co-Maker Name</b></td><td>${c.comakerFirstname || ""} ${
    c.comakerLastname || ""
  }</td></tr>
      </tbody>
    </table>
  `;
}
// export const verifyOTP = onRequest((req, res) => {
//   corsHandler(req, res, async () => {
//     const { email, otp } = req.body;

//     if (!email || !otp) {
//       res.status(400).send({
//         message: "OTP is required",
//       });
//       return;
//     }

//     try {
//       const pendingUserReference = admin
//         .firestore()
//         .collection("pending_user")
//         .doc(email);

//       const pendingUserDoc = await pendingUserReference.get();

//       if (!pendingUserDoc.exists) {
//         res.status(400).send({ message: "User not found" });
//         return;
//       }

//       const pendingUserData = pendingUserDoc.data();

//       if (pendingUserData?.otp !== otp) {
//         res.status(400).send({
//           message: "Invalid OTP",
//         });
//         return;
//       }

//       if (Date.now() > pendingUserData?.expiresAt) {
//         res.status(400).send({
//           message: "OTP has expired",
//         });
//         return;
//       }

//       // create a user

//       const userRecord = await admin.auth().createUser({
//         email: pendingUserData?.email,
//         password: pendingUserData?.password,
//         displayName: `${pendingUserData?.firstname} ${pendingUserData?.lastname} ${pendingUserData?.middlename}`,
//       });

//       // after created store it

//       await admin.firestore().collection("users").doc(userRecord.uid).set({
//         email: pendingUserData?.email,
//         createdAt: admin.firestore.FieldValue.serverTimestamp(),
//       });

//       await pendingUserReference.delete();

//       const customToken = await admin.auth().createCustomToken(userRecord.uid);

//       res.status(200).send({
//         message: "Succesfully Registered",
//         token: customToken,
//       });
//     } catch (error) {
//       res.status(500).send({
//         error,
//       });
//     }
//   });
// });

// noreplypassword008

// 🧩 Utility: Flatten nested objects
function flattenObject(obj: any, prefix = "", res: Record<string, any> = {}) {
  for (const key in obj) {
    const value = obj[key];
    const newKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "object" && value !== null) {
      flattenObject(value, newKey, res);
    } else {
      res[newKey] = value;
    }
  }
  return res;
}
