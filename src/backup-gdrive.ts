import { drive } from "@googleapis/drive";
import { JWT } from "google-auth-library";
import { env } from "./env";
import { exec, execSync } from "child_process";
import { unlink } from "fs/promises";
import { statSync } from "fs";
import * as path from "path";
import * as os from "os";
import { filesize } from "filesize";
import { createReadStream } from "fs";
import dayjs from "dayjs";

const auth = new JWT({
  email: env.SERVICE_ACCOUNT.client_email,
  key: env.SERVICE_ACCOUNT.private_key,
  scopes: ["https://www.googleapis.com/auth/drive"],
});

const gdrive = drive({
  version: "v3",
  auth: auth
});

const deleteStaleBackups = async (cutOffDate: Date) => {
  try {
    const folderAccess = await gdrive.files.get({
      fileId: env.FOLDER_ID,
      fields: "id",
    });

    if (!folderAccess.data.id) {
      console.error(`No access to FOLDER_ID: ${env.FOLDER_ID}`);
      return;
    }

    const res = await gdrive.files.list({
      pageSize: 100,
      fields: "nextPageToken, files(id, createdTime)",
      q: `'${env.FOLDER_ID}' in parents and trashed=false and mimeType = 'application/gzip' and createdTime < '${cutOffDate.toISOString()}'`,
    });

    if (!res.data.files || res.data.files.length === 0) {
      console.log("No old backups found for deletion.");
      return;
    }

    for (const file of res.data.files) {
      if (file.id) {
        await gdrive.files.delete({ fileId: file.id });
        console.log(`Deleted backup file with ID: ${file.id}`);
      }
    }
  } catch (error) {
    console.error("Error deleting old backups:", error);
  }
};

const dumpToFile = async (filepath: string) => {
  return new Promise((resolve, reject) => {
    exec(
      `pg_dump --dbname=${env.DATABASE_URL} --format=custom | gzip > ${filepath}`,
      (err, stdout, stderr) => {
        if (err) {
          reject({
            error: err,
            stderr: stderr.trimEnd(),
          });
          return;
        }

        if (stderr) {
          console.warn(stderr.trimEnd());
        }

        const isFileValid = execSync(`gzip -cd ${filepath} | head -c1`).length > 0;

        if (!isFileValid) {
          console.error("Backup file is empty or corrupted.");
          reject("Backup file is empty or corrupted.");
          return;
        }

        console.log(`Backup file size: ${filesize(statSync(filepath).size)}`);
        console.log(`Backup file created at: ${filepath}`);

        resolve(stdout);
      }
    );
  });
};

const pushToDrive = async (filename: string, filepath: string) => {
  try {
    const folderAccess = await gdrive.files.get({
      fileId: env.FOLDER_ID,
      fields: "id",
    });

    if (!folderAccess.data.id) {
      console.error(`No access to FOLDER_ID: ${env.FOLDER_ID}`);
      return;
    }

    const fileMetadata = {
      name: filename,
      parents: [env.FOLDER_ID],
    };

    const media = {
      mimeType: "application/gzip",
      body: createReadStream(filepath),
    };

    await gdrive.files.create({
      requestBody: fileMetadata,
      media: media,
    });

    console.log(`Backup ${filename} uploaded to Google Drive!`);
  } catch (error) {
    console.error("Error uploading backup to Google Drive:", error);
  }
};

export async function run() {
  try {
    if (env.RETENTION && env.RETENTION !== "disabled") {
      console.log(`Deleting old backups older than ${env.RETENTION} day(s)`);
      const cutOffDate = dayjs().subtract(env.RETENTION, 'day').toDate();
      await deleteStaleBackups(cutOffDate);
      console.log("Old backups deletion complete.");
    }

    const timestamp = new Date()
      .toISOString()
      .replace(/:/g, "-")
      .replace(".", "-");

    const filename = `${env.FILE_PREFIX}${timestamp}.tar.gz`;
    const filepath = path.join(os.tmpdir(), filename);

    console.log(`Starting backup: ${filename}`);
    await dumpToFile(filepath);

    console.log("Backup complete. Uploading to Google Drive...");
    await pushToDrive(filename, filepath);

    await unlink(filepath);
    console.log("Backup file removed locally.");
  } catch (error) {
    console.error("Something went wrong during the backup process:", error);
  }
}
