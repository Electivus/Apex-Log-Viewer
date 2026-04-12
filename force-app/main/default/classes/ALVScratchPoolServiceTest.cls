@IsTest
private class ALVScratchPoolServiceTest {
    private static ALV_ScratchOrgPool__c createPool(String poolKey) {
        ALV_ScratchOrgPool__c pool = new ALV_ScratchOrgPool__c(
            PoolKey__c = poolKey,
            Enabled__c = true,
            TargetSize__c = 3,
            ScratchDurationDays__c = 30,
            LeaseTtlSeconds__c = 5400,
            AcquireTimeoutSeconds__c = 600,
            MinRemainingMinutes__c = 120,
            ProvisioningMode__c = 'definition',
            DefinitionHash__c = 'baseline-hash',
            SeedVersion__c = 'seed-v1'
        );
        insert pool;
        return pool;
    }

    private static ALV_ScratchOrgPoolSlot__c createSlot(ALV_ScratchOrgPool__c pool, String slotKey) {
        ALV_ScratchOrgPoolSlot__c slot = new ALV_ScratchOrgPoolSlot__c(
            Pool__c = pool.Id,
            SlotKey__c = slotKey,
            ScratchAlias__c = 'ALV_E2E_' + slotKey,
            LeaseState__c = 'available',
            HealthState__c = 'unknown'
        );
        insert slot;
        return slot;
    }

    @IsTest
    static void acquirePrefersHealthySlots() {
        ALV_ScratchOrgPool__c pool = createPool('alv-e2e');
        createSlot(pool, 'slot-02');
        ALV_ScratchOrgPoolSlot__c healthy = createSlot(pool, 'slot-01');
        healthy.HealthState__c = 'healthy';
        healthy.DefinitionHash__c = 'baseline-hash';
        healthy.SeedVersion__c = 'seed-v1';
        healthy.ScratchUsername__c = 'slot01@example.com';
        healthy.ScratchLoginUrl__c = 'https://slot01.scratch.my.salesforce.com';
        healthy.ScratchAuthUrl__c = 'force://slot01-auth';
        healthy.ScratchExpiresAt__c = Datetime.now().addDays(7);
        update healthy;

        System.Test.startTest();
        ALVScratchPoolService.LeaseResponse response = ALVScratchPoolService.acquire(new Map<String, Object>{
            'poolKey' => 'alv-e2e',
            'leaseOwner' => 'jest:test',
            'leaseTtlSeconds' => 120,
            'definitionHash' => 'baseline-hash',
            'seedVersion' => 'seed-v1',
            'minRemainingMinutes' => 60
        });
        System.Test.stopTest();

        System.assertEquals(true, response.ok);
        System.assertEquals('slot-01', response.slotKey);
        System.assertEquals(false, response.needsCreate);
        System.assertEquals('leased', response.leaseState);
        System.assertEquals('force://slot01-auth', response.scratchAuthUrl);
    }

    @IsTest
    static void acquireRequiresScratchAuthUrlForReuse() {
        ALV_ScratchOrgPool__c pool = createPool('alv-auth');
        ALV_ScratchOrgPoolSlot__c slot = createSlot(pool, 'slot-01');
        slot.HealthState__c = 'healthy';
        slot.DefinitionHash__c = 'baseline-hash';
        slot.SeedVersion__c = 'seed-v1';
        slot.ScratchUsername__c = 'slot01@example.com';
        slot.ScratchLoginUrl__c = 'https://slot01.scratch.my.salesforce.com';
        slot.ScratchExpiresAt__c = Datetime.now().addDays(7);
        update slot;

        System.Test.startTest();
        ALVScratchPoolService.LeaseResponse response = ALVScratchPoolService.acquire(new Map<String, Object>{
            'poolKey' => 'alv-auth',
            'leaseOwner' => 'jest:test',
            'leaseTtlSeconds' => 120,
            'definitionHash' => 'baseline-hash',
            'seedVersion' => 'seed-v1',
            'minRemainingMinutes' => 60
        });
        System.Test.stopTest();

        System.assertEquals('slot-01', response.slotKey);
        System.assertEquals(true, response.needsCreate);
        System.assertEquals('provisioning', response.leaseState);
    }

    @IsTest
    static void acquireReclaimsExpiredLease() {
        ALV_ScratchOrgPool__c pool = createPool('alv-expired');
        ALV_ScratchOrgPoolSlot__c slot = createSlot(pool, 'slot-expired');
        slot.LeaseState__c = 'leased';
        slot.LeaseOwner__c = 'old-owner';
        slot.LeaseToken__c = 'old-token';
        slot.LeaseExpiresAt__c = Datetime.now().addMinutes(-10);
        slot.HealthState__c = 'broken';
        update slot;

        System.Test.startTest();
        ALVScratchPoolService.LeaseResponse response = ALVScratchPoolService.acquire(new Map<String, Object>{
            'poolKey' => 'alv-expired',
            'leaseOwner' => 'new-owner',
            'leaseTtlSeconds' => 120,
            'definitionHash' => 'baseline-hash',
            'seedVersion' => 'seed-v1',
            'minRemainingMinutes' => 60
        });
        System.Test.stopTest();

        System.assertEquals('slot-expired', response.slotKey);
        System.assertEquals(true, response.needsCreate);
        System.assertEquals('provisioning', response.leaseState);
    }

    @IsTest
    static void heartbeatExtendsLease() {
        ALV_ScratchOrgPool__c pool = createPool('alv-heartbeat');
        ALV_ScratchOrgPoolSlot__c slot = createSlot(pool, 'slot-heartbeat');
        slot.LeaseState__c = 'leased';
        slot.LeaseOwner__c = 'owner';
        slot.LeaseToken__c = 'lease-token';
        slot.LeaseExpiresAt__c = Datetime.now().addMinutes(5);
        update slot;

        System.Test.startTest();
        ALVScratchPoolService.LeaseResponse response = ALVScratchPoolService.heartbeat(new Map<String, Object>{
            'poolKey' => 'alv-heartbeat',
            'slotKey' => 'slot-heartbeat',
            'leaseToken' => 'lease-token',
            'leaseTtlSeconds' => 3600
        });
        System.Test.stopTest();

        System.assertEquals('slot-heartbeat', response.slotKey);
        System.assertNotEquals(null, response.leaseExpiresAt);
        System.assert(response.leaseExpiresAt > Datetime.now().addMinutes(30));
    }

    @IsTest
    static void releaseMarksNeedsRecreateWhenRequested() {
        ALV_ScratchOrgPool__c pool = createPool('alv-release');
        ALV_ScratchOrgPoolSlot__c slot = createSlot(pool, 'slot-release');
        slot.LeaseState__c = 'leased';
        slot.LeaseOwner__c = 'owner';
        slot.LeaseToken__c = 'lease-token';
        slot.LeaseExpiresAt__c = Datetime.now().addMinutes(5);
        update slot;

        System.Test.startTest();
        ALVScratchPoolService.LeaseResponse response = ALVScratchPoolService.releaseLease(new Map<String, Object>{
            'poolKey' => 'alv-release',
            'slotKey' => 'slot-release',
            'leaseToken' => 'lease-token',
            'success' => false,
            'needsRecreate' => true,
            'lastRunResult' => 'failed',
            'errorMessage' => 'slot failed health checks',
            'scratchAuthUrl' => 'force://stale-auth'
        });
        System.Test.stopTest();

        System.assertEquals('slot-release', response.slotKey);
        ALV_ScratchOrgPoolSlot__c refreshed = [
            SELECT LeaseState__c, HealthState__c, LeaseToken__c, LeaseOwner__c, LastError__c, ScratchAuthUrl__c
            FROM ALV_ScratchOrgPoolSlot__c
            WHERE Id = :slot.Id
        ];
        System.assertEquals('available', refreshed.LeaseState__c);
        System.assertEquals('needs_recreate', refreshed.HealthState__c);
        System.assertEquals(null, refreshed.LeaseToken__c);
        System.assertEquals(null, refreshed.LeaseOwner__c);
        System.assertEquals('slot failed health checks', refreshed.LastError__c);
        System.assertEquals(null, refreshed.ScratchAuthUrl__c);
    }

    @IsTest
    static void releasePreservesSuccessWhileForcingRecreateWithoutAuthUrl() {
        ALV_ScratchOrgPool__c pool = createPool('alv-release-success');
        ALV_ScratchOrgPoolSlot__c slot = createSlot(pool, 'slot-release-success');
        slot.LeaseState__c = 'leased';
        slot.LeaseOwner__c = 'owner';
        slot.LeaseToken__c = 'lease-token';
        slot.LeaseExpiresAt__c = Datetime.now().addMinutes(5);
        update slot;

        System.Test.startTest();
        ALVScratchPoolService.releaseLease(new Map<String, Object>{
            'poolKey' => 'alv-release-success',
            'slotKey' => 'slot-release-success',
            'leaseToken' => 'lease-token',
            'success' => true,
            'needsRecreate' => true,
            'lastRunResult' => 'completed'
        });
        System.Test.stopTest();

        ALV_ScratchOrgPoolSlot__c refreshed = [
            SELECT HealthState__c, ScratchAuthUrl__c, UsageCount__c
            FROM ALV_ScratchOrgPoolSlot__c
            WHERE Id = :slot.Id
        ];
        System.assertEquals('needs_recreate', refreshed.HealthState__c);
        System.assertEquals(null, refreshed.ScratchAuthUrl__c);
        System.assertEquals(1, refreshed.UsageCount__c);
    }

    @IsTest
    static void finalizeFailsWhenScratchOrgInfoIsMissing() {
        ALV_ScratchOrgPool__c pool = createPool('alv-finalize');
        ALV_ScratchOrgPoolSlot__c slot = createSlot(pool, 'slot-finalize');
        slot.LeaseState__c = 'provisioning';
        slot.LeaseOwner__c = 'owner';
        slot.LeaseToken__c = 'lease-token';
        slot.LeaseExpiresAt__c = Datetime.now().addMinutes(5);
        update slot;

        try {
            ALVScratchPoolService.finalizeLease(new Map<String, Object>{
                'poolKey' => 'alv-finalize',
                'slotKey' => 'slot-finalize',
                'leaseToken' => 'lease-token',
                'definitionHash' => 'baseline-hash',
                'seedVersion' => 'seed-v1',
                'created' => true
            });
            System.assert(false, 'Expected finalize to fail when no ScratchOrgInfo exists.');
        } catch (ALVScratchPoolService.PoolRequestException error) {
            System.assert(error.getMessage().contains('404|No ScratchOrgInfo was found'));
        }
    }
}
