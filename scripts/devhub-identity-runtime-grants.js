'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { xmlValue } = require('./devhub-identity-app');

const RUNTIME_PERMISSION_SET = 'ALV_ScratchOrgPoolService';
const OBJECT_FLAGS = {
  allowRead: 'PermissionsRead',
  allowCreate: 'PermissionsCreate',
  allowEdit: 'PermissionsEdit',
  allowDelete: 'PermissionsDelete',
  viewAllRecords: 'PermissionsViewAllRecords',
  modifyAllRecords: 'PermissionsModifyAllRecords',
  viewAllFields: 'PermissionsViewAllFields'
};
const FIELD_FLAGS = { readable: 'PermissionsRead', editable: 'PermissionsEdit' };
const identifier = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_]*$/.test(value);

function readRuntimeSource() {
  return fs.readFile(
    path.join(
      __dirname,
      '..',
      'force-app',
      'main',
      'default',
      'permissionsets',
      `${RUNTIME_PERMISSION_SET}.permissionset-meta.xml`
    ),
    'utf8'
  );
}

function contractEntries(source, tag, key, flags) {
  const entries = new Map();
  for (const [, body] of source.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))) {
    const name = xmlValue(body, key);
    if (!/^[a-zA-Z][a-zA-Z0-9_.]*$/.test(name) || entries.has(name))
      throw new Error('Cannot verify the runtime grant inventory: invalid or duplicate source entry.');
    entries.set(
      name,
      Object.fromEntries(
        Object.entries(flags).map(([xml, api]) => {
          const value = xmlValue(body, xml);
          if (!['', 'true', 'false'].includes(value))
            throw new Error('Cannot verify the runtime grant inventory: invalid source flag.');
          return [api, value === 'true'];
        })
      )
    );
  }
  if (!entries.size) throw new Error('Cannot verify the runtime grant inventory: missing source entries.');
  return entries;
}

async function permissionDescription(sf, target, object, required) {
  const description = await sf(['sobject', 'describe', '--target-org', target, '--sobject', object]);
  const fields = Array.isArray(description.fields)
    ? description.fields.filter(field => field.name?.startsWith('Permissions'))
    : [];
  if (
    !fields.length ||
    fields.some(field => !identifier(field.name) || field.type !== 'boolean') ||
    new Set(fields.map(field => field.name)).size !== fields.length ||
    required.some(name => !fields.some(field => field.name === name))
  )
    throw new Error(`Cannot verify the runtime grant inventory: incomplete ${object} permission schema.`);
  return { fields: fields.map(field => field.name), children: description.childRelationships };
}

function verifyRows(records, expected, key, fields, permissionSetId, category) {
  if (
    records.length !== expected.size ||
    new Set(records.map(record => record[key])).size !== records.length ||
    records.some(record => {
      const contract = expected.get(record[key]);
      return (
        !contract ||
        record.ParentId !== permissionSetId ||
        fields.some(field => record[field] !== (contract[field] ?? false))
      );
    })
  )
    throw new Error(
      `Runtime ${category} grants differ from the complete expected inventory; no grants will be changed.`
    );
}

// Re-read effective grants on every invocation. A saved deployment or assignment
// identity is not evidence that this set's contents still match the contract.
async function verifyRuntimeGrants(sf, target, query, expectedId) {
  const source = await readRuntimeSource();
  const objects = contractEntries(source, 'objectPermissions', 'object', OBJECT_FLAGS);
  const fields = contractEntries(source, 'fieldPermissions', 'field', FIELD_FLAGS);
  const classes = contractEntries(source, 'classAccesses', 'apexClass', { enabled: 'enabled' });
  const userPermissions = contractEntries(source, 'userPermissions', 'name', { enabled: 'enabled' });
  const expectedUserPermissions = new Map(
    [...userPermissions].map(([name, entry]) => [`Permissions${name}`, entry.enabled])
  );
  const permissionSchema = await permissionDescription(sf, target, 'PermissionSet', [
    ...expectedUserPermissions.keys()
  ]);
  const children = permissionSchema.children;
  if (
    !Array.isArray(children) ||
    children.some(child => !identifier(child.childSObject) || !identifier(child.field)) ||
    ['ObjectPermissions', 'FieldPermissions', 'SetupEntityAccess'].some(
      object => !children.some(child => child.childSObject === object && child.field === 'ParentId')
    )
  )
    throw new Error('Cannot verify the complete runtime grant inventory: incomplete grant relationships.');
  const permissions = await query(
    `SELECT FIELDS(ALL) FROM PermissionSet WHERE Name = '${RUNTIME_PERMISSION_SET}' LIMIT 2`
  );
  const permission = permissions[0];
  if (
    permissions.length !== 1 ||
    !permission.Id ||
    (expectedId && permission.Id !== expectedId) ||
    permission.Name !== RUNTIME_PERMISSION_SET ||
    permission.IsOwnedByProfile !== false ||
    permission.HasActivationRequired !== false ||
    permission.LicenseId !== null ||
    permission.Type !== 'Regular' ||
    permission.NamespacePrefix !== null ||
    permissionSchema.fields.some(name => permission[name] !== (expectedUserPermissions.get(name) ?? false))
  )
    throw new Error('Runtime user-permission grants differ or are incompletely reported; no grants will be changed.');
  const permissionSetId = permission.Id;
  const objectSchema = await permissionDescription(sf, target, 'ObjectPermissions', Object.values(OBJECT_FLAGS));
  const actualObjects = await query(
    `SELECT ParentId, SobjectType, ${objectSchema.fields.join(', ')} FROM ObjectPermissions WHERE ParentId = '${permissionSetId}'`
  );
  verifyRows(actualObjects, objects, 'SobjectType', objectSchema.fields, permissionSetId, 'object');
  const fieldSchema = await permissionDescription(sf, target, 'FieldPermissions', Object.values(FIELD_FLAGS));
  const actualFields = await query(
    `SELECT ParentId, Field, ${fieldSchema.fields.join(', ')} FROM FieldPermissions WHERE ParentId = '${permissionSetId}'`
  );
  verifyRows(actualFields, fields, 'Field', fieldSchema.fields, permissionSetId, 'field');
  const expectedClasses = [...classes].filter(([, entry]) => entry.enabled).map(([name]) => name);
  const actualClasses = await query(
    `SELECT Id, Name, NamespacePrefix FROM ApexClass WHERE Name IN (${expectedClasses.map(name => `'${name}'`).join(',')}) AND NamespacePrefix = null`,
    true
  );
  if (
    actualClasses.length !== expectedClasses.length ||
    new Set(actualClasses.map(item => item.Name)).size !== actualClasses.length ||
    new Set(actualClasses.map(item => item.Id)).size !== actualClasses.length ||
    actualClasses.some(item => !item.Id || !expectedClasses.includes(item.Name) || item.NamespacePrefix !== null)
  )
    throw new Error('Runtime Apex grants cannot be verified against the expected classes.');
  const access = await query(
    `SELECT ParentId, SetupEntityId, SetupEntityType FROM SetupEntityAccess WHERE ParentId = '${permissionSetId}'`
  );
  if (
    access.length !== actualClasses.length ||
    new Set(access.map(item => item.SetupEntityId)).size !== access.length ||
    access.some(
      item =>
        item.ParentId !== permissionSetId ||
        item.SetupEntityType !== 'ApexClass' ||
        !actualClasses.some(apex => apex.Id === item.SetupEntityId)
    )
  )
    throw new Error(
      'Runtime setup-entity grants differ from the exact expected Apex access; no grants will be changed.'
    );
  for (const child of children) {
    if (
      (child.field === 'ParentId' &&
        ['ObjectPermissions', 'FieldPermissions', 'SetupEntityAccess'].includes(child.childSObject)) ||
      (child.field === 'PermissionSetId' &&
        ['PermissionSetAssignment', 'SessionPermSetActivation'].includes(child.childSObject))
    )
      continue;
    const extras = await query(
      `SELECT Id FROM ${child.childSObject} WHERE ${child.field} = '${permissionSetId}' LIMIT 1`
    );
    if (extras.length)
      throw new Error(`Runtime related grants differ in ${child.childSObject}; no grants will be changed.`);
  }
  return {
    permissionSetId,
    objects: actualObjects,
    fieldCount: actualFields.length,
    classes: actualClasses.map(item => item.Name),
    userPermissionCount: permissionSchema.fields.length,
    verifiedAt: new Date().toISOString()
  };
}

module.exports = { RUNTIME_PERMISSION_SET, readRuntimeSource, verifyRuntimeGrants };
