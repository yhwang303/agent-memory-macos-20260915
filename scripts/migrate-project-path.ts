/**
 * 迁移脚本：将 shadow-person 项目路径更新为 shadow-folk
 */

import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';

const dbPath = path.join(os.homedir(), '.agent-memory', 'agent-memory.db');

const OLD_PROJECT = 'd:/github/shadow-person';
const NEW_PROJECT = 'd:/github/shadow-folk';

console.log('🔄 开始迁移项目路径...');
console.log(`   从: ${OLD_PROJECT}`);
console.log(`   到: ${NEW_PROJECT}`);
console.log(`   数据库: ${dbPath}`);
console.log('');

const db = new Database(dbPath);

// 获取所有表
const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[];
console.log('📋 数据库表:', tables.map(t => t.name).join(', '));
console.log('');

// 检查每个表中是否有 project 字段，并更新
let totalUpdated = 0;

for (const { name: tableName } of tables) {
  // 获取表的列信息
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[];
  const hasProject = columns.some(col => col.name === 'project');
  
  if (hasProject) {
    // 统计受影响的行数
    const countResult = db.prepare(`SELECT COUNT(*) as count FROM ${tableName} WHERE project = ?`).get(OLD_PROJECT) as { count: number };
    const count = countResult.count;
    
    if (count > 0) {
      console.log(`📦 表 ${tableName}: 发现 ${count} 条记录需要更新`);
      
      // 执行更新
      const result = db.prepare(`UPDATE ${tableName} SET project = ? WHERE project = ?`).run(NEW_PROJECT, OLD_PROJECT);
      console.log(`   ✅ 已更新 ${result.changes} 条记录`);
      totalUpdated += result.changes;
    } else {
      console.log(`📦 表 ${tableName}: 无需更新`);
    }
  }
}

console.log('');
console.log(`🎉 迁移完成！共更新 ${totalUpdated} 条记录`);

db.close();
