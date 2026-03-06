import assert from 'assert/strict';
import { EventEmitter } from 'events';
import { workspace } from 'vscode';
import { createDebugLevel, listDebugLevels } from '../salesforce/traceflags';
import { __setHttpsRequestImplForTests, __resetHttpsRequestImplForTests } from '../salesforce/http';
import { CacheManager } from '../utils/cacheManager';
import type { OrgAuth } from '../salesforce/types';

suite('listDebugLevels', () => {
  const originalGetConfiguration = workspace.getConfiguration;

  teardown(async () => {
    __resetHttpsRequestImplForTests();
    (workspace.getConfiguration as any) = originalGetConfiguration;
    await CacheManager.delete();
  });

  test('parses developer names from response', async () => {
    const auth: OrgAuth = { accessToken: 't', instanceUrl: 'https://example.com' };
    __setHttpsRequestImplForTests((opts: any, cb: any) => {
      const req = new EventEmitter() as any;
      req.on = function (event: string, listener: any) {
        EventEmitter.prototype.on.call(this, event, listener);
        return this;
      };
      req.end = () => {
        const res = new EventEmitter() as any;
        res.statusCode = 200;
        res.headers = {};
        res.on = function (event: string, listener: any) {
          EventEmitter.prototype.on.call(this, event, listener);
          return this;
        };
        res.setEncoding = () => {};
        res.req = req;
        cb(res);
        process.nextTick(() => {
          res.emit(
            'data',
            Buffer.from(JSON.stringify({ records: [{ DeveloperName: 'DL1' }, { DeveloperName: 'DL2' }] }))
          );
          res.emit('end');
        });
      };
      return req;
    });

    const levels = await listDebugLevels(auth);
    assert.deepEqual(levels, ['DL1', 'DL2']);
  });

  test('reuses cached debug levels', async () => {
    (workspace.getConfiguration as any) = () => ({ get: () => undefined });
    const auth: OrgAuth = { accessToken: 't', instanceUrl: 'https://example.com' } as OrgAuth;
    let called = 0;
    __setHttpsRequestImplForTests((opts: any, cb: any) => {
      called++;
      const req = new EventEmitter() as any;
      req.on = function (event: string, listener: any) {
        EventEmitter.prototype.on.call(this, event, listener);
        return this;
      };
      req.end = () => {
        const res = new EventEmitter() as any;
        res.statusCode = 200;
        res.headers = {};
        res.on = function (event: string, listener: any) {
          EventEmitter.prototype.on.call(this, event, listener);
          return this;
        };
        res.setEncoding = () => {};
        res.req = req;
        cb(res);
        process.nextTick(() => {
          res.emit('data', Buffer.from(JSON.stringify({ records: [{ DeveloperName: 'DL1' }] })));
          res.emit('end');
        });
      };
      return req;
    });

    const memento = {
      _s: new Map<string, unknown>(),
      get(key: string) {
        return this._s.get(key);
      },
      update(key: string, value: unknown) {
        if (value === undefined) {
          this._s.delete(key);
        } else {
          this._s.set(key, value);
        }
        return Promise.resolve();
      }
    } as any;
    CacheManager.init(memento);

    const first = await listDebugLevels(auth);
    const second = await listDebugLevels(auth);
    assert.deepEqual(first, ['DL1']);
    assert.deepEqual(second, ['DL1']);
    assert.equal(called, 1, 'expected single HTTP request');
  });

  test('invalidates cached debug levels after creating a DebugLevel', async () => {
    (workspace.getConfiguration as any) = () => ({ get: () => undefined });
    const auth: OrgAuth = { accessToken: 't', instanceUrl: 'https://example.com' } as OrgAuth;
    let queryCalls = 0;
    __setHttpsRequestImplForTests((opts: any, cb: any) => {
      const req = new EventEmitter() as any;
      let body = '';
      req.on = function (event: string, listener: any) {
        EventEmitter.prototype.on.call(this, event, listener);
        return this;
      };
      req.write = (chunk: any) => {
        body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
      };
      req.end = () => {
        const res = new EventEmitter() as any;
        res.headers = {};
        res.on = function (event: string, listener: any) {
          EventEmitter.prototype.on.call(this, event, listener);
          return this;
        };
        res.setEncoding = () => {};
        res.req = req;
        cb(res);
        process.nextTick(() => {
          const path = String(opts?.path || '');
          if (path.includes('/tooling/query')) {
            queryCalls++;
            res.statusCode = 200;
            const records =
              queryCalls === 1
                ? [{ DeveloperName: 'DL1' }]
                : [{ DeveloperName: 'DL1' }, { DeveloperName: 'DL2' }];
            res.emit('data', Buffer.from(JSON.stringify({ records })));
            res.emit('end');
            return;
          }
          if (String(opts?.method || 'GET') === 'POST' && path.endsWith('/tooling/sobjects/DebugLevel')) {
            res.statusCode = 201;
            const parsed = JSON.parse(body);
            assert.equal(parsed.DeveloperName, 'DL2');
            res.emit('data', Buffer.from(JSON.stringify({ success: true, id: '7dl000000000002AAA' })));
            res.emit('end');
            return;
          }
          throw new Error(`Unexpected request: ${String(opts?.method || 'GET')} ${path}`);
        });
      };
      return req;
    });

    const memento = {
      _s: new Map<string, unknown>(),
      get(key: string) {
        return this._s.get(key);
      },
      update(key: string, value: unknown) {
        if (value === undefined) {
          this._s.delete(key);
        } else {
          this._s.set(key, value);
        }
        return Promise.resolve();
      }
    } as any;
    CacheManager.init(memento);

    const first = await listDebugLevels(auth);
    await createDebugLevel(auth, {
      developerName: 'DL2',
      masterLabel: 'DL2',
      language: 'en_US',
      workflow: 'INFO',
      validation: 'INFO',
      callout: 'INFO',
      apexCode: 'DEBUG',
      apexProfiling: 'INFO',
      visualforce: 'INFO',
      system: 'INFO',
      database: 'INFO',
      wave: 'INFO',
      nba: 'INFO',
      dataAccess: 'INFO'
    });
    const second = await listDebugLevels(auth);

    assert.deepEqual(first, ['DL1']);
    assert.deepEqual(second, ['DL1', 'DL2']);
    assert.equal(queryCalls, 2, 'expected cache invalidation to force a second query');
  });
});
