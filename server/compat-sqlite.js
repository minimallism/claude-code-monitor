const { DatabaseSync } = require("node:sqlite");

/**
 * node:sqlite 的轻量包装，使其 API 接近 better-sqlite3。
 *
 * 背景：
 * - better-sqlite3 是原生 C++ 模块，在某些 Node 版本或平台上可能编译失败。
 * - Node.js 22+ 内置 node:sqlite，但它是异步/同步混合的新 API（DatabaseSync）。
 * - 本项目大部分代码按 better-sqlite3 的同步风格编写（db.prepare(...).get/all/run、
 *   db.transaction(...)），因此需要一层薄包装来抹平差异。
 *
 * 当前包装仅覆盖实际用到的 API：exec、pragma、prepare、transaction、close。
 */
class Database {
  constructor(filePath) {
    this._db = new DatabaseSync(filePath);
  }

  exec(sql) {
    this._db.exec(sql);
    return this;
  }

  /**
   * 执行 PRAGMA 语句。
   *
   * - 设置型 pragma（含 =）直接 exec，返回 undefined。
   * - 查询型 pragma 返回单行结果；options.simple 为 true 或只有一列时返回该列的值。
   */
  pragma(str, options) {
    if (str.includes("=")) {
      this._db.exec(`PRAGMA ${str}`);
      return undefined;
    }
    const row = this._db.prepare(`PRAGMA ${str}`).get();
    if (!row) return undefined;
    const keys = Object.keys(row);
    if (options?.simple || keys.length === 1) return row[keys[0]];
    return row;
  }

  prepare(sql) {
    return this._db.prepare(sql);
  }

  /**
   * 包装函数为 SQLite 事务。
   *
   * 使用 BEGIN / COMMIT / ROLLBACK 实现；函数执行成功则提交，抛错则回滚。
   */
  transaction(fn) {
    const db = this._db;
    const wrapper = (...args) => {
      db.exec("BEGIN");
      try {
        const result = fn(...args);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    };
    return wrapper;
  }

  close() {
    this._db.close();
  }
}

module.exports = Database;
