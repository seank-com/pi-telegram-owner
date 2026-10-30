import assert from 'node:assert/strict';
import test from 'node:test';
import { Check } from 'typebox/value';
import { GroupSendParameters } from '../src/work.ts';

test('group send conditional branches explicitly declare object types for xAI', () => {
    const visit = (schema: any) => {
        if (!schema || typeof schema !== 'object') return;
        for (const keyword of ['anyOf', 'oneOf']) {
            for (const branch of schema[keyword] ?? []) {
                assert.equal(branch.type, 'object', `${keyword} branch must explicitly be an object`);
                visit(branch);
            }
        }
        if (schema.not) visit(schema.not);
    };
    visit(GroupSendParameters);
});

test('group send schema preserves recipient routing and terminal-disposition constraints', () => {
    for (const value of [
        { kind: 'request', text: 'Synthetic request', recipients: ['@peer_bot'] },
        { kind: 'reply', text: 'Synthetic reply', requestId: 'request' },
        { kind: 'reply', text: 'Synthetic blocked reply', requestId: 'request', disposition: 'blocked' },
        { kind: 'notify', text: 'Synthetic information' },
        { kind: 'notify', text: 'Synthetic directed information', recipients: ['@peer_bot'] },
    ]) assert.equal(Check(GroupSendParameters as any, value), true, JSON.stringify(value));
    for (const value of [
        null, [], 'text',
        { kind: 'request', text: 'Missing recipients' },
        { kind: 'request', text: 'Empty recipients', recipients: [] },
        { kind: 'request', text: 'Forbidden requestId', recipients: ['@peer_bot'], requestId: 'request' },
        { kind: 'request', text: 'Forbidden disposition', recipients: ['@peer_bot'], disposition: 'completed' },
        { kind: 'reply', text: 'Missing requestId' },
        { kind: 'reply', text: 'Forbidden recipients', requestId: 'request', recipients: ['@peer_bot'] },
        { kind: 'notify', text: 'Forbidden requestId', requestId: 'request' },
        { kind: 'notify', text: 'Forbidden disposition', disposition: 'completed' },
        { kind: 'notify', text: 'Unknown field', extra: true },
    ]) assert.equal(Check(GroupSendParameters as any, value), false, JSON.stringify(value));
});
