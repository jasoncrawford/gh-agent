import fs from "fs";
import crypto from "crypto";

const ID_FILE = ".worker-id";

export function getWorkerId(): string {
  try {
    return fs.readFileSync(ID_FILE, "utf8").trim();
  } catch {
    const id = crypto.randomUUID();
    fs.writeFileSync(ID_FILE, id);
    return id;
  }
}
