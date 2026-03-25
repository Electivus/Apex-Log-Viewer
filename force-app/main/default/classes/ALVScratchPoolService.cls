public without sharing class ALVScratchPoolService {
    public class PoolRequestException extends Exception {}

    public class LeaseResponse {
        public Boolean ok = true;
        public String poolKey;
        public String slotKey;
        public String scratchAlias;
        public String leaseToken;
        public String leaseState;
        public String leaseOwner;
        public Datetime leaseExpiresAt;
        public Boolean needsCreate;
        public String scratchUsername;
        public String scratchLoginUrl;
        public String scratchAuthUrl;
        public String scratchOrgId;
        public String scratchOrgInfoId;
        public String activeScratchOrgId;
        public Datetime scratchExpiresAt;
        public String definitionHash;
        public String seedVersion;
        public String provisioningMode;
        public String snapshotName;
        public Integer scratchDurationDays;
    }

    private static final String STATE_AVAILABLE = 'available';
    private static final String STATE_LEASED = 'leased';
    private static final String STATE_PROVISIONING = 'provisioning';
    private static final String STATE_DISABLED = 'disabled';
    private static final String HEALTH_HEALTHY = 'healthy';
    private static final String HEALTH_NEEDS_RECREATE = 'needs_recreate';
    private static final String HEALTH_BROKEN = 'broken';
    private static final String HEALTH_UNKNOWN = 'unknown';

    public static LeaseResponse acquire(Map<String, Object> payload) {
        String poolKey = requireString(payload, 'poolKey');
        String leaseOwner = requireString(payload, 'leaseOwner');
        Integer leaseTtlSeconds = Math.max(60, integerValue(payload, 'leaseTtlSeconds', 5400));
        Integer minRemainingMinutes = Math.max(0, integerValue(payload, 'minRemainingMinutes', 120));
        String requestedDefinitionHash = stringValue(payload, 'definitionHash');
        String requestedSeedVersion = stringValue(payload, 'seedVersion');

        ALV_ScratchOrgPool__c pool = lockPool(poolKey);
        List<ALV_ScratchOrgPoolSlot__c> slots = querySlots(pool.Id);
        if (slots.isEmpty()) {
            raise(409, 'No scratch-org pool slots are configured for pool ' + poolKey + '.');
        }

        Datetime nowValue = Datetime.now();
        Map<Id, ALV_ScratchOrgPoolSlot__c> dirtyById = new Map<Id, ALV_ScratchOrgPoolSlot__c>();
        ALV_ScratchOrgPoolSlot__c bestHealthy;
        ALV_ScratchOrgPoolSlot__c bestNeedsCreate;

        for (ALV_ScratchOrgPoolSlot__c slot : slots) {
            if (STATE_DISABLED == slot.LeaseState__c) {
                continue;
            }

            if (isExpiredLease(slot, nowValue)) {
                resetLease(slot, nowValue);
                dirtyById.put(slot.Id, slot);
            }

            if (slot.LeaseState__c != null && slot.LeaseState__c != STATE_AVAILABLE) {
                continue;
            }

            if (slotNeedsCreate(slot, requestedDefinitionHash, requestedSeedVersion, minRemainingMinutes, nowValue)) {
                if (bestNeedsCreate == null || compareSlotKeys(slot.SlotKey__c, bestNeedsCreate.SlotKey__c) < 0) {
                    bestNeedsCreate = slot;
                }
            } else if (bestHealthy == null || compareSlotKeys(slot.SlotKey__c, bestHealthy.SlotKey__c) < 0) {
                bestHealthy = slot;
            }
        }

        ALV_ScratchOrgPoolSlot__c selected = bestHealthy != null ? bestHealthy : bestNeedsCreate;
        if (selected == null) {
            raise(409, 'No scratch-org pool slot is currently available for pool ' + poolKey + '.');
        }

        Boolean needsCreate = slotNeedsCreate(selected, requestedDefinitionHash, requestedSeedVersion, minRemainingMinutes, nowValue);
        selected.LeaseOwner__c = leaseOwner;
        selected.LeaseToken__c = generateLeaseToken();
        selected.LeaseExpiresAt__c = nowValue.addSeconds(leaseTtlSeconds);
        selected.LastHeartbeatAt__c = nowValue;
        selected.LastLeaseStartedAt__c = nowValue;
        selected.LeaseState__c = needsCreate ? STATE_PROVISIONING : STATE_LEASED;
        selected.LastError__c = null;
        dirtyById.put(selected.Id, selected);

        update dirtyById.values();
        return toLeaseResponse(selected, needsCreate);
    }

    public static LeaseResponse heartbeat(Map<String, Object> payload) {
        ALV_ScratchOrgPoolSlot__c slot = lockLeasedSlot(payload);
        Integer leaseTtlSeconds = Math.max(60, integerValue(payload, 'leaseTtlSeconds', 5400));
        Datetime nowValue = Datetime.now();
        slot.LastHeartbeatAt__c = nowValue;
        slot.LeaseExpiresAt__c = nowValue.addSeconds(leaseTtlSeconds);
        update slot;
        return toLeaseResponse(slot, STATE_PROVISIONING == slot.LeaseState__c);
    }

    public static LeaseResponse finalizeLease(Map<String, Object> payload) {
        ALV_ScratchOrgPoolSlot__c slot = lockLeasedSlot(payload);
        String poolKey = requireString(payload, 'poolKey');
        String definitionHash = stringValue(payload, 'definitionHash');
        String seedVersion = stringValue(payload, 'seedVersion');
        String lastRunResult = stringValue(payload, 'lastRunResult');
        String scratchAuthUrl = stringValue(payload, 'scratchAuthUrl');

        List<ScratchOrgInfo> infos = [
            SELECT Id, ScratchOrg, SignupUsername, LoginUrl, ExpirationDate, Status
            FROM ScratchOrgInfo
            WHERE alvPoolKey__c = :poolKey AND alvSlotKey__c = :slot.SlotKey__c
            ORDER BY CreatedDate DESC
            LIMIT 1
        ];
        if (infos.isEmpty()) {
            raise(404, 'No ScratchOrgInfo was found for pool ' + poolKey + ' and slot ' + slot.SlotKey__c + '.');
        }

        ScratchOrgInfo info = infos[0];
        ActiveScratchOrg activeScratch = null;
        List<ActiveScratchOrg> activeScratchOrgs = [
            SELECT Id, ScratchOrg, SignupUsername, ExpirationDate
            FROM ActiveScratchOrg
            WHERE ScratchOrgInfoId = :info.Id
            LIMIT 1
        ];
        if (!activeScratchOrgs.isEmpty()) {
            activeScratch = activeScratchOrgs[0];
        }

        slot.ScratchOrgInfoId__c = info.Id;
        slot.ScratchOrgId__c = info.ScratchOrg;
        slot.ScratchUsername__c = info.SignupUsername;
        slot.ScratchLoginUrl__c = info.LoginUrl;
        slot.ScratchAuthUrl__c = scratchAuthUrl;
        slot.ScratchExpiresAt__c = toScratchExpirationDateTime(info.ExpirationDate);
        slot.ActiveScratchOrgId__c = activeScratch != null ? activeScratch.Id : null;
        slot.DefinitionHash__c = definitionHash;
        slot.SeedVersion__c = seedVersion;
        slot.HealthState__c = HEALTH_HEALTHY;
        slot.LeaseState__c = STATE_LEASED;
        slot.LastRunResult__c = lastRunResult;
        slot.LastError__c = null;
        update slot;

        return toLeaseResponse(slot, false);
    }

    public static LeaseResponse releaseLease(Map<String, Object> payload) {
        ALV_ScratchOrgPoolSlot__c slot = lockLeasedSlot(payload);
        Datetime nowValue = Datetime.now();
        Boolean success = booleanValue(payload, 'success', true);
        Boolean needsRecreate = booleanValue(payload, 'needsRecreate', false);
        String lastRunResult = stringValue(payload, 'lastRunResult');
        String errorMessage = stringValue(payload, 'errorMessage');
        String scratchAuthUrl = stringValue(payload, 'scratchAuthUrl');

        slot.LeaseOwner__c = null;
        slot.LeaseToken__c = null;
        slot.LeaseExpiresAt__c = null;
        slot.LastHeartbeatAt__c = nowValue;
        slot.LastLeaseReleasedAt__c = nowValue;
        slot.LeaseState__c = STATE_AVAILABLE;
        slot.LastRunResult__c = lastRunResult;
        slot.LastError__c = truncateLongText(errorMessage);
        if (success) {
            slot.UsageCount__c = (slot.UsageCount__c == null ? 0 : slot.UsageCount__c) + 1;
            if (needsRecreate) {
                slot.HealthState__c = HEALTH_NEEDS_RECREATE;
                slot.ScratchAuthUrl__c = null;
            } else {
                slot.ScratchAuthUrl__c = scratchAuthUrl;
            }
            if (!needsRecreate && (slot.HealthState__c == null || slot.HealthState__c == HEALTH_UNKNOWN)) {
                slot.HealthState__c = HEALTH_HEALTHY;
            }
        } else {
            slot.HealthState__c = needsRecreate ? HEALTH_NEEDS_RECREATE : HEALTH_BROKEN;
            if (needsRecreate) {
                slot.ScratchAuthUrl__c = null;
            } else {
                slot.ScratchAuthUrl__c = scratchAuthUrl;
            }
        }
        update slot;

        return toLeaseResponse(slot, needsRecreate);
    }

    private static ALV_ScratchOrgPool__c lockPool(String poolKey) {
        List<ALV_ScratchOrgPool__c> pools = [
            SELECT Id, PoolKey__c, Enabled__c, TargetSize__c, ScratchDurationDays__c, LeaseTtlSeconds__c, AcquireTimeoutSeconds__c,
                   MinRemainingMinutes__c, ProvisioningMode__c, SnapshotName__c, DefinitionHash__c, SeedVersion__c
            FROM ALV_ScratchOrgPool__c
            WHERE PoolKey__c = :poolKey
            LIMIT 1
            FOR UPDATE
        ];
        if (pools.isEmpty()) {
            raise(404, 'Scratch-org pool ' + poolKey + ' was not found.');
        }
        if (pools[0].Enabled__c == false) {
            raise(409, 'Scratch-org pool ' + poolKey + ' is disabled.');
        }
        return pools[0];
    }

    private static List<ALV_ScratchOrgPoolSlot__c> querySlots(Id poolId) {
        return [
            SELECT Id, SlotKey__c, ScratchAlias__c, LeaseState__c, LeaseOwner__c, LeaseToken__c, LeaseExpiresAt__c,
                   LastHeartbeatAt__c, LastLeaseStartedAt__c, LastLeaseReleasedAt__c, LastRunResult__c, HealthState__c,
                   ScratchUsername__c, ScratchLoginUrl__c, ScratchAuthUrl__c, ScratchOrgId__c, ScratchOrgInfoId__c, ActiveScratchOrgId__c,
                   ScratchExpiresAt__c, DefinitionHash__c, SeedVersion__c, UsageCount__c, LastError__c,
                   Pool__r.PoolKey__c, Pool__r.ScratchDurationDays__c, Pool__r.ProvisioningMode__c, Pool__r.SnapshotName__c
            FROM ALV_ScratchOrgPoolSlot__c
            WHERE Pool__c = :poolId
        ];
    }

    private static ALV_ScratchOrgPoolSlot__c lockLeasedSlot(Map<String, Object> payload) {
        String poolKey = requireString(payload, 'poolKey');
        String slotKey = requireString(payload, 'slotKey');
        String leaseToken = requireString(payload, 'leaseToken');

        List<ALV_ScratchOrgPoolSlot__c> slots = [
            SELECT Id, SlotKey__c, ScratchAlias__c, LeaseState__c, LeaseOwner__c, LeaseToken__c, LeaseExpiresAt__c,
                   LastHeartbeatAt__c, LastLeaseStartedAt__c, LastLeaseReleasedAt__c, LastRunResult__c, HealthState__c,
                   ScratchUsername__c, ScratchLoginUrl__c, ScratchAuthUrl__c, ScratchOrgId__c, ScratchOrgInfoId__c, ActiveScratchOrgId__c,
                   ScratchExpiresAt__c, DefinitionHash__c, SeedVersion__c, UsageCount__c, LastError__c,
                   Pool__r.PoolKey__c, Pool__r.ScratchDurationDays__c, Pool__r.ProvisioningMode__c, Pool__r.SnapshotName__c
            FROM ALV_ScratchOrgPoolSlot__c
            WHERE SlotKey__c = :slotKey AND Pool__r.PoolKey__c = :poolKey
            LIMIT 1
            FOR UPDATE
        ];
        if (slots.isEmpty()) {
            raise(404, 'Scratch-org pool slot ' + slotKey + ' was not found in pool ' + poolKey + '.');
        }
        ALV_ScratchOrgPoolSlot__c slot = slots[0];
        if (slot.LeaseToken__c != leaseToken) {
            raise(409, 'Scratch-org pool slot ' + slotKey + ' is no longer leased by this caller.');
        }
        return slot;
    }

    private static Boolean isExpiredLease(ALV_ScratchOrgPoolSlot__c slot, Datetime nowValue) {
        return slot.LeaseToken__c != null && slot.LeaseExpiresAt__c != null && slot.LeaseExpiresAt__c <= nowValue;
    }

    private static void resetLease(ALV_ScratchOrgPoolSlot__c slot, Datetime nowValue) {
        slot.LeaseState__c = STATE_AVAILABLE;
        slot.LeaseOwner__c = null;
        slot.LeaseToken__c = null;
        slot.LeaseExpiresAt__c = null;
        slot.LastLeaseReleasedAt__c = nowValue;
        slot.LastError__c = truncateLongText('Lease reclaimed automatically after TTL expiration.');
        if (slot.HealthState__c == null || slot.HealthState__c == HEALTH_UNKNOWN) {
            slot.HealthState__c = HEALTH_UNKNOWN;
        }
    }

    private static Boolean slotNeedsCreate(
        ALV_ScratchOrgPoolSlot__c slot,
        String definitionHash,
        String seedVersion,
        Integer minRemainingMinutes,
        Datetime nowValue
    ) {
        if (slot.HealthState__c == HEALTH_NEEDS_RECREATE || slot.HealthState__c == HEALTH_BROKEN) {
            return true;
        }
        if (
            String.isBlank(slot.ScratchAlias__c) ||
            String.isBlank(slot.ScratchUsername__c) ||
            String.isBlank(slot.ScratchLoginUrl__c) ||
            String.isBlank(slot.ScratchAuthUrl__c)
        ) {
            return true;
        }
        if (!String.isBlank(definitionHash) && slot.DefinitionHash__c != definitionHash) {
            return true;
        }
        if (!String.isBlank(seedVersion) && slot.SeedVersion__c != seedVersion) {
            return true;
        }
        if (slot.ScratchExpiresAt__c == null) {
            return true;
        }
        return slot.ScratchExpiresAt__c <= nowValue.addMinutes(minRemainingMinutes);
    }

    private static LeaseResponse toLeaseResponse(ALV_ScratchOrgPoolSlot__c slot, Boolean needsCreate) {
        LeaseResponse response = new LeaseResponse();
        response.poolKey = slot.Pool__r != null ? slot.Pool__r.PoolKey__c : null;
        response.slotKey = slot.SlotKey__c;
        response.scratchAlias = slot.ScratchAlias__c;
        response.leaseToken = slot.LeaseToken__c;
        response.leaseState = slot.LeaseState__c;
        response.leaseOwner = slot.LeaseOwner__c;
        response.leaseExpiresAt = slot.LeaseExpiresAt__c;
        response.needsCreate = needsCreate;
        response.scratchUsername = slot.ScratchUsername__c;
        response.scratchLoginUrl = slot.ScratchLoginUrl__c;
        response.scratchAuthUrl = slot.ScratchAuthUrl__c;
        response.scratchOrgId = slot.ScratchOrgId__c;
        response.scratchOrgInfoId = slot.ScratchOrgInfoId__c;
        response.activeScratchOrgId = slot.ActiveScratchOrgId__c;
        response.scratchExpiresAt = slot.ScratchExpiresAt__c;
        response.definitionHash = slot.DefinitionHash__c;
        response.seedVersion = slot.SeedVersion__c;
        response.provisioningMode = slot.Pool__r != null ? slot.Pool__r.ProvisioningMode__c : null;
        response.snapshotName = slot.Pool__r != null ? slot.Pool__r.SnapshotName__c : null;
        response.scratchDurationDays =
            slot.Pool__r != null && slot.Pool__r.ScratchDurationDays__c != null
                ? Integer.valueOf(slot.Pool__r.ScratchDurationDays__c)
                : null;
        return response;
    }

    private static Integer compareSlotKeys(String left, String right) {
        String normalizedLeft = String.isBlank(left) ? 'zzzzzzzzzz' : left;
        String normalizedRight = String.isBlank(right) ? 'zzzzzzzzzz' : right;
        if (normalizedLeft == normalizedRight) {
            return 0;
        }
        return normalizedLeft < normalizedRight ? -1 : 1;
    }

    private static Datetime toScratchExpirationDateTime(Date expirationDate) {
        if (expirationDate == null) {
            return null;
        }
        return Datetime.newInstanceGmt(expirationDate, Time.newInstance(23, 59, 59, 0));
    }

    private static String truncateLongText(String value) {
        if (String.isBlank(value)) {
            return null;
        }
        return value.length() <= 32768 ? value : value.substring(0, 32768);
    }

    private static String generateLeaseToken() {
        Blob source = Blob.valueOf(String.valueOf(Crypto.getRandomLong()) + ':' + String.valueOf(Datetime.now().getTime()));
        return EncodingUtil.convertToHex(Crypto.generateDigest('SHA-256', source)).substring(0, 32);
    }

    private static String requireString(Map<String, Object> payload, String key) {
        String value = stringValue(payload, key);
        if (String.isBlank(value)) {
            raise(400, 'Missing required field ' + key + '.');
        }
        return value;
    }

    private static String stringValue(Map<String, Object> payload, String key) {
        Object rawValue = payload != null ? payload.get(key) : null;
        return rawValue == null ? null : String.valueOf(rawValue).trim();
    }

    private static Integer integerValue(Map<String, Object> payload, String key, Integer fallbackValue) {
        Object rawValue = payload != null ? payload.get(key) : null;
        if (rawValue == null) {
            return fallbackValue;
        }
        try {
            if (rawValue instanceof Decimal) {
                return Integer.valueOf((Decimal) rawValue);
            }
            return Integer.valueOf(String.valueOf(rawValue));
        } catch (Exception ignored) {
            return fallbackValue;
        }
    }

    private static Boolean booleanValue(Map<String, Object> payload, String key, Boolean fallbackValue) {
        Object rawValue = payload != null ? payload.get(key) : null;
        if (rawValue == null) {
            return fallbackValue;
        }
        if (rawValue instanceof Boolean) {
            return (Boolean) rawValue;
        }
        String normalized = String.valueOf(rawValue).trim().toLowerCase();
        if (normalized == 'true' || normalized == '1') {
            return true;
        }
        if (normalized == 'false' || normalized == '0') {
            return false;
        }
        return fallbackValue;
    }

    private static void raise(Integer statusCode, String message) {
        throw new PoolRequestException(String.valueOf(statusCode) + '|' + message);
    }
}
