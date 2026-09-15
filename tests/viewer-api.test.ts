/**
 * Unit tests for Memory Viewer API
 * 
 * These tests verify the viewer API endpoints and database query functions
 * that were added to support the memory viewer frontend.
 * 
 * Run with: npm test
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

// Get the project root directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Configuration
const API_BASE = 'http://127.0.0.1:3847';
const VIEWER_URL = `${API_BASE}/viewer.html`;

// Helper function to make HTTP requests
function makeRequest(url: string, options: http.RequestOptions = {}): Promise<{
  statusCode: number;
  data: any;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions: http.RequestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: 5000,
    };

    const req = http.request(reqOptions, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        let data = body;
        try {
          data = JSON.parse(body);
        } catch {
          // Keep as string if not JSON
        }
        resolve({
          statusCode: res.statusCode || 0,
          data,
          headers: res.headers,
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}

// Helper function to check if worker is running
async function isWorkerRunning(): Promise<boolean> {
  try {
    const res = await makeRequest(`${API_BASE}/api/viewer/projects`);
    return res.statusCode === 200;
  } catch {
    return false;
  }
}

describe('Memory Viewer API Tests', () => {
  let workerRunning = false;

  before(async () => {
    // Check if worker service is running
    workerRunning = await isWorkerRunning();
    if (!workerRunning) {
      console.log('\n⚠️  Worker service is not running.');
      console.log('   Please start it with: npm run worker:start');
      console.log('   Some tests will be skipped.\n');
    }
  });

  describe('Static File Serving', () => {
    it('should serve viewer.html file', async (t) => {
      if (!workerRunning) {
        t.skip('Worker not running');
        return;
      }

      const res = await makeRequest(VIEWER_URL);
      assert.strictEqual(res.statusCode, 200, 'Should return 200 status');
      assert.ok(
        res.headers['content-type']?.includes('text/html'),
        'Should have text/html content type'
      );
      assert.ok(
        typeof res.data === 'string' && res.data.includes('<!DOCTYPE html>'),
        'Should return HTML content'
      );
      assert.ok(
        typeof res.data === 'string' && res.data.includes('AgentMem-Viewer'),
        'Should contain viewer title'
      );
    });

    it('should serve viewer at /viewer path as well', async (t) => {
      if (!workerRunning) {
        t.skip('Worker not running');
        return;
      }

      const res = await makeRequest(`${API_BASE}/viewer`);
      assert.strictEqual(res.statusCode, 200, 'Should return 200 status');
      assert.ok(
        typeof res.data === 'string' && res.data.includes('<!DOCTYPE html>'),
        'Should return HTML content'
      );
    });
  });

  describe('GET /api/viewer/projects', () => {
    it('should return project list', async (t) => {
      if (!workerRunning) {
        t.skip('Worker not running');
        return;
      }

      const res = await makeRequest(`${API_BASE}/api/viewer/projects`);
      
      assert.strictEqual(res.statusCode, 200, 'Should return 200 status');
      assert.strictEqual(res.data.success, true, 'Should have success: true');
      assert.ok(Array.isArray(res.data.data), 'data should be an array');
      assert.ok(typeof res.data.count === 'number', 'count should be a number');
      assert.strictEqual(res.data.count, res.data.data.length, 'count should match data length');
    });

    it('should return distinct project names', async (t) => {
      if (!workerRunning) {
        t.skip('Worker not running');
        return;
      }

      const res = await makeRequest(`${API_BASE}/api/viewer/projects`);
      
      if (res.data.data.length > 0) {
        // Check that all items are strings
        res.data.data.forEach((project: any) => {
          assert.ok(typeof project === 'string', 'Each project should be a string');
        });
        
        // Check that projects are unique
        const uniqueProjects = [...new Set(res.data.data)];
        assert.strictEqual(
          uniqueProjects.length,
          res.data.data.length,
          'Projects should be unique'
        );
      }
    });
  });

  describe('GET /api/viewer/sessions', () => {
    it('should return sessions list', async (t) => {
      if (!workerRunning) {
        t.skip('Worker not running');
        return;
      }

      const res = await makeRequest(`${API_BASE}/api/viewer/sessions`);
      
      assert.strictEqual(res.statusCode, 200, 'Should return 200 status');
      assert.strictEqual(res.data.success, true, 'Should have success: true');
      assert.ok(Array.isArray(res.data.data), 'data should be an array');
      assert.ok(typeof res.data.count === 'number', 'count should be a number');
    });

    it('should respect limit parameter', async (t) => {
      if (!workerRunning) {
        t.skip('Worker not running');
        return;
      }

      const res = await makeRequest(`${API_BASE}/api/viewer/sessions?limit=5`);
      
      assert.strictEqual(res.statusCode, 200, 'Should return 200 status');
      assert.ok(res.data.data.length <= 5, 'Should return at most 5 sessions');
    });

    it('should filter by project', async (t) => {
      if (!workerRunning) {
        t.skip('Worker not running');
        return;
      }

      // First get a project name
      const projectsRes = await makeRequest(`${API_BASE}/api/viewer/projects`);
      if (projectsRes.data.data.length === 0) {
        t.skip('No projects available');
        return;
      }

      const project = projectsRes.data.data[0];
      const res = await makeRequest(
        `${API_BASE}/api/viewer/sessions?project=${encodeURIComponent(project)}`
      );
      
      assert.strictEqual(res.statusCode, 200, 'Should return 200 status');
      
      // All returned sessions should belong to the specified project
      if (res.data.data.length > 0) {
        res.data.data.forEach((session: any) => {
          assert.strictEqual(
            session.project,
            project,
            'Session project should match filter'
          );
        });
      }
    });

    it('should return session with expected fields', async (t) => {
      if (!workerRunning) {
        t.skip('Worker not running');
        return;
      }

      const res = await makeRequest(`${API_BASE}/api/viewer/sessions?limit=1`);
      
      if (res.data.data.length > 0) {
        const session = res.data.data[0];
        
        // Check required fields exist
        assert.ok('id' in session, 'Session should have id');
        assert.ok('project' in session, 'Session should have project');
        assert.ok('started_at' in session, 'Session should have started_at');
        assert.ok('status' in session, 'Session should have status');
      }
    });
  });

  describe('GET /api/viewer/observations', () => {
    it('should return observations list', async (t) => {
      if (!workerRunning) {
        t.skip('Worker not running');
        return;
      }

      const res = await makeRequest(`${API_BASE}/api/viewer/observations`);
      
      assert.strictEqual(res.statusCode, 200, 'Should return 200 status');
      assert.strictEqual(res.data.success, true, 'Should have success: true');
      assert.ok(Array.isArray(res.data.data), 'data should be an array');
      assert.ok(typeof res.data.count === 'number', 'count should be a number');
    });

    it('should respect limit parameter', async (t) => {
      if (!workerRunning) {
        t.skip('Worker not running');
        return;
      }

      const res = await makeRequest(`${API_BASE}/api/viewer/observations?limit=3`);
      
      assert.strictEqual(res.statusCode, 200, 'Should return 200 status');
      assert.ok(res.data.data.length <= 3, 'Should return at most 3 observations');
    });

    it('should filter by project', async (t) => {
      if (!workerRunning) {
        t.skip('Worker not running');
        return;
      }

      const projectsRes = await makeRequest(`${API_BASE}/api/viewer/projects`);
      if (projectsRes.data.data.length === 0) {
        t.skip('No projects available');
        return;
      }

      const project = projectsRes.data.data[0];
      const res = await makeRequest(
        `${API_BASE}/api/viewer/observations?project=${encodeURIComponent(project)}`
      );
      
      assert.strictEqual(res.statusCode, 200, 'Should return 200 status');
      
      if (res.data.data.length > 0) {
        res.data.data.forEach((obs: any) => {
          assert.strictEqual(
            obs.project,
            project,
            'Observation project should match filter'
          );
        });
      }
    });

    it('should return observation with expected fields', async (t) => {
      if (!workerRunning) {
        t.skip('Worker not running');
        return;
      }

      const res = await makeRequest(`${API_BASE}/api/viewer/observations?limit=1`);
      
      if (res.data.data.length > 0) {
        const obs = res.data.data[0];
        
        assert.ok('id' in obs, 'Observation should have id');
        assert.ok('project' in obs, 'Observation should have project');
        assert.ok('type' in obs, 'Observation should have type');
        assert.ok('created_at' in obs, 'Observation should have created_at');
      }
    });
  });

  describe('GET /api/viewer/summaries', () => {
    it('should return summaries list', async (t) => {
      if (!workerRunning) {
        t.skip('Worker not running');
        return;
      }

      const res = await makeRequest(`${API_BASE}/api/viewer/summaries`);
      
      assert.strictEqual(res.statusCode, 200, 'Should return 200 status');
      assert.strictEqual(res.data.success, true, 'Should have success: true');
      assert.ok(Array.isArray(res.data.data), 'data should be an array');
      assert.ok(typeof res.data.count === 'number', 'count should be a number');
    });

    it('should respect limit parameter', async (t) => {
      if (!workerRunning) {
        t.skip('Worker not running');
        return;
      }

      const res = await makeRequest(`${API_BASE}/api/viewer/summaries?limit=2`);
      
      assert.strictEqual(res.statusCode, 200, 'Should return 200 status');
      assert.ok(res.data.data.length <= 2, 'Should return at most 2 summaries');
    });

    it('should filter by project', async (t) => {
      if (!workerRunning) {
        t.skip('Worker not running');
        return;
      }

      const projectsRes = await makeRequest(`${API_BASE}/api/viewer/projects`);
      if (projectsRes.data.data.length === 0) {
        t.skip('No projects available');
        return;
      }

      const project = projectsRes.data.data[0];
      const res = await makeRequest(
        `${API_BASE}/api/viewer/summaries?project=${encodeURIComponent(project)}`
      );
      
      assert.strictEqual(res.statusCode, 200, 'Should return 200 status');
      
      if (res.data.data.length > 0) {
        res.data.data.forEach((summary: any) => {
          assert.strictEqual(
            summary.project,
            project,
            'Summary project should match filter'
          );
        });
      }
    });

    it('should return summary with expected fields', async (t) => {
      if (!workerRunning) {
        t.skip('Worker not running');
        return;
      }

      const res = await makeRequest(`${API_BASE}/api/viewer/summaries?limit=1`);
      
      if (res.data.data.length > 0) {
        const summary = res.data.data[0];
        
        assert.ok('id' in summary, 'Summary should have id');
        assert.ok('project' in summary, 'Summary should have project');
        assert.ok('created_at' in summary, 'Summary should have created_at');
      }
    });
  });

  describe('Error Handling', () => {
    it('should return 404 for unknown API endpoints', async (t) => {
      if (!workerRunning) {
        t.skip('Worker not running');
        return;
      }

      const res = await makeRequest(`${API_BASE}/api/viewer/nonexistent`);
      assert.strictEqual(res.statusCode, 404, 'Should return 404 status');
    });
  });

  describe('viewer.html File', () => {
    it('should exist in web directory', () => {
      const viewerPath = path.join(projectRoot, 'web', 'viewer.html');
      assert.ok(fs.existsSync(viewerPath), 'viewer.html should exist');
    });

    it('should be valid HTML', () => {
      const viewerPath = path.join(projectRoot, 'web', 'viewer.html');
      const content = fs.readFileSync(viewerPath, 'utf-8');
      
      assert.ok(content.includes('<!DOCTYPE html>'), 'Should have DOCTYPE');
      assert.ok(content.includes('<html'), 'Should have html tag');
      assert.ok(content.includes('</html>'), 'Should close html tag');
      assert.ok(content.includes('<head>'), 'Should have head tag');
      assert.ok(content.includes('<body>'), 'Should have body tag');
    });

    it('should have required UI elements', () => {
      const viewerPath = path.join(projectRoot, 'web', 'viewer.html');
      const content = fs.readFileSync(viewerPath, 'utf-8');
      
      // Check for tabs
      assert.ok(content.includes('data-tab="sessions"'), 'Should have sessions tab');
      assert.ok(content.includes('data-tab="observations"'), 'Should have observations tab');
      assert.ok(content.includes('data-tab="summaries"'), 'Should have summaries tab');
      
      // Check for filter
      assert.ok(content.includes('projectFilter'), 'Should have project filter');
      
      // Check for modal
      assert.ok(content.includes('modal'), 'Should have modal element');
    });

    it('should have correct API base URL', () => {
      const viewerPath = path.join(projectRoot, 'web', 'viewer.html');
      const content = fs.readFileSync(viewerPath, 'utf-8');
      
      assert.ok(
        content.includes('const API_BASE = `http://127.0.0.1:${__viewerPort}`'),
        'Should have correct API base URL'
      );
    });

    it('should have all required API endpoint calls', () => {
      const viewerPath = path.join(projectRoot, 'web', 'viewer.html');
      const content = fs.readFileSync(viewerPath, 'utf-8');
      
      assert.ok(content.includes('/api/viewer/projects'), 'Should call projects API');
      assert.ok(content.includes('/api/viewer/sessions'), 'Should call sessions API');
      assert.ok(content.includes('/api/viewer/observations'), 'Should call observations API');
      assert.ok(content.includes('/api/viewer/summaries'), 'Should call summaries API');
    });
  });
});

// Run tests
console.log('\n🧪 Running Memory Viewer API Tests...\n');
