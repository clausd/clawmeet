'use strict';
/**
 * ClawMeet — SQLite persistence layer
 * Stores messages and topics so history survives server restarts.
 */

const Database = require('better-sqlite3');
const path     = require('path');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'clawmeet.db');

const db = new Database(DB_FILE);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS topics (
    topic   TEXT PRIMARY KEY,
    passkey TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS messages (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    topic   TEXT    NOT NULL,
    type    TEXT    NOT NULL,
    name    TEXT,
    color   TEXT,
    text    TEXT    NOT NULL,
    ts      INTEGER NOT NULL,
    FOREIGN KEY (topic) REFERENCES topics(topic) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(topic, id);
`);

// Prepared statements
const stmts = {
  upsertTopic:      db.prepare('INSERT OR REPLACE INTO topics (topic, passkey) VALUES (?, ?)'),
  deleteTopic:      db.prepare('DELETE FROM topics WHERE topic = ?'),
  getTopics:        db.prepare('SELECT topic, passkey FROM topics'),
  getTopicByPasskey: db.prepare('SELECT topic FROM topics WHERE passkey = ?'),

  appendMessage: db.prepare(
    'INSERT INTO messages (topic, type, name, color, text, ts) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  getHistory: db.prepare(
    `SELECT type, name, color, text, ts FROM messages
     WHERE topic = ?
     ORDER BY id DESC LIMIT ?`
  ),
  pruneOld: db.prepare(
    `DELETE FROM messages WHERE topic = ? AND id NOT IN (
       SELECT id FROM messages WHERE topic = ? ORDER BY id DESC LIMIT ?
     )`
  ),
};

const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || '1000', 10);

module.exports = {
  /**
   * Seed or update a topic+passkey. Used at startup from topics.json and via API.
   */
  upsertTopic(topic, passkey) {
    stmts.upsertTopic.run(topic, passkey);
  },

  deleteTopic(topic) {
    stmts.deleteTopic.run(topic);
  },

  /** Returns array of { topic, passkey } */
  getTopics() {
    return stmts.getTopics.all();
  },

  /** Returns topic string or undefined */
  getTopicByPasskey(passkey) {
    const row = stmts.getTopicByPasskey.get(passkey);
    return row?.topic;
  },

  /**
   * Persist a message and prune oldest beyond MAX_HISTORY.
   * @param {string} topic
   * @param {{ type, name?, color?, text, ts }} msg
   */
  appendMessage(topic, msg) {
    stmts.appendMessage.run(topic, msg.type, msg.name ?? null, msg.color ?? null, msg.text, msg.ts);
    stmts.pruneOld.run(topic, topic, MAX_HISTORY);
  },

  /**
   * Returns last `limit` messages for topic in chronological order.
   */
  getHistory(topic, limit = MAX_HISTORY) {
    const rows = stmts.getHistory.all(topic, limit);
    rows.reverse(); // DESC → ASC
    return rows;
  },

  close() {
    db.close();
  },
};
