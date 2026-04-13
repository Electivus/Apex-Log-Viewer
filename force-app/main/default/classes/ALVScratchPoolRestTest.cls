@IsTest
private class ALVScratchPoolRestTest {
    @IsTest
    static void restAcquireRouteReturnsJson() {
        ALV_ScratchOrgPool__c pool = new ALV_ScratchOrgPool__c(
            PoolKey__c = 'rest-pool',
            Enabled__c = true,
            TargetSize__c = 1,
            ScratchDurationDays__c = 30,
            LeaseTtlSeconds__c = 120,
            AcquireTimeoutSeconds__c = 60,
            MinRemainingMinutes__c = 15,
            ProvisioningMode__c = 'definition'
        );
        insert pool;
        insert new ALV_ScratchOrgPoolSlot__c(
            Pool__c = pool.Id,
            SlotKey__c = 'rest-slot',
            ScratchAlias__c = 'ALV_E2E_REST',
            LeaseState__c = 'available',
            HealthState__c = 'healthy',
            ScratchUsername__c = 'rest-slot@example.com',
            ScratchLoginUrl__c = 'https://rest-slot.scratch.my.salesforce.com',
            ScratchAuthUrl__c = 'force://rest-slot-auth',
            ScratchExpiresAt__c = Datetime.now().addDays(3),
            DefinitionHash__c = 'hash',
            SeedVersion__c = 'seed'
        );

        System.RestRequest request = new System.RestRequest();
        request.requestURI = '/services/apexrest/alv/scratch-pool/v1/acquire';
        request.httpMethod = 'POST';
        request.requestBody = Blob.valueOf('{"poolKey":"rest-pool","leaseOwner":"rest-test","leaseTtlSeconds":120,"definitionHash":"hash","seedVersion":"seed","minRemainingMinutes":15}');
        System.RestContext.request = request;
        System.RestContext.response = new System.RestResponse();

        System.Test.startTest();
        ALVScratchPoolRest.handlePost();
        System.Test.stopTest();

        System.assertEquals(200, System.RestContext.response.statusCode);
        System.assert(System.RestContext.response.responseBody.toString().contains('"slotKey":"rest-slot"'));
        System.assert(System.RestContext.response.responseBody.toString().contains('"scratchAuthUrl":"force://rest-slot-auth"'));
    }

    @IsTest
    static void restUnknownRouteReturns404() {
        System.RestRequest request = new System.RestRequest();
        request.requestURI = '/services/apexrest/alv/scratch-pool/v1/unknown';
        request.httpMethod = 'POST';
        request.requestBody = Blob.valueOf('{}');
        System.RestContext.request = request;
        System.RestContext.response = new System.RestResponse();

        System.Test.startTest();
        ALVScratchPoolRest.handlePost();
        System.Test.stopTest();

        System.assertEquals(404, System.RestContext.response.statusCode);
    }
}
