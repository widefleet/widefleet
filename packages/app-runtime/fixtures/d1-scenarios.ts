export const exerciseDatabase = async (db: D1Database, scenario: string) => {
  const duplicates = 'SELECT id AS x, id+10 AS x, name AS "10", id AS "2" FROM items ORDER BY id';

  switch (scenario) {
    case "prepare":
      db.prepare("SELECT ?").bind("private-parameter");

      return { prepared: true };
    case "raw":
      return db.prepare(duplicates).raw({ columnNames: true });
    case "empty":
      return db
        .prepare("SELECT id AS x, id AS x FROM items WHERE id=-1")
        .raw({ columnNames: true });
    case "types":
      return db
        .prepare("SELECT ? AS blob1, ? AS blob2, ? AS nil, ? AS n, ? AS text")
        .bind(
          new Uint8Array([0, 128, 255]),
          new Uint8Array([9, 10]).buffer,
          null,
          4.25,
          "private-value",
        )
        .raw();
    case "all":
      return db.prepare(duplicates).all();
    case "first":
      return db.prepare(duplicates).first();
    case "column":
      return db.prepare(duplicates).first("x");
    case "missing":
      return db.prepare(duplicates).first("private-missing-column");
    case "raw-write":
      return db.prepare("UPDATE counter SET n=n+1 RETURNING n AS x,n+10 AS x").raw();
    case "run":
      return db.prepare("UPDATE counter SET n=n+1").run();
    case "batch":
      return db.batch([
        db.prepare("UPDATE counter SET n=n+1"),
        db.prepare("SELECT n FROM counter"),
      ]);
    case "exec":
      return db.exec("UPDATE counter SET n=n+1;\nSELECT n FROM counter;");
    case "error":
      return db.prepare("SELECT * FROM private_missing_table").all();
    case "batch-error":
      return db.batch([
        db.prepare("UPDATE counter SET n=99"),
        db.prepare("INSERT INTO private_missing_table VALUES(1)"),
      ]);
    case "exec-error":
      return db.exec("UPDATE counter SET n=99;\nINSERT INTO private_missing_table VALUES(1);");
    case "session": {
      const session = db.withSession();
      const initial = session.getBookmark();
      const value = await session.prepare("SELECT n FROM counter").first("n");
      const bookmark = session.getBookmark();

      if (bookmark === null) throw new Error("Missing D1 session bookmark");
      const resumed = db.withSession(bookmark);
      const transferred = resumed.getBookmark() === bookmark;
      const next = await resumed.batch([resumed.prepare("SELECT n FROM counter")]);

      return { initial, value, transferred, hasBookmark: resumed.getBookmark() !== null, next };
    }

    default:
      throw new Error("Unknown D1 test scenario");
  }
};
