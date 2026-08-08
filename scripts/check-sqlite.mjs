import { DatabaseSync } from "node:sqlite";

const database = new DatabaseSync(":memory:");
database.exec("CREATE TABLE smoke (value TEXT NOT NULL)");
database.prepare("INSERT INTO smoke (value) VALUES (?)").run("ready");
const row = database.prepare("SELECT value FROM smoke").get();
database.close();

if (row?.value !== "ready") {
  throw new Error("The built-in SQLite smoke check returned the wrong value.");
}

console.log("node:sqlite smoke check passed");
