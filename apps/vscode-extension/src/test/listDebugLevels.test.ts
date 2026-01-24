import assert from 'assert/strict';
import { EventEmitter } from 'events';
import { workspace } from 'vscode';
import { listDebugLevels } from '../salesforce/traceflags';
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
});
