@RestResource(urlMapping='/alv/scratch-pool/v1/*')
global without sharing class ALVScratchPoolRest {
    @HttpPost
    global static void handlePost() {
        RestRequest request = RestContext.request;
        RestResponse response = RestContext.response;
        response.addHeader('Content-Type', 'application/json');

        try {
            String body = request.requestBody == null ? null : request.requestBody.toString();
            Map<String, Object> payload = String.isBlank(body)
                ? new Map<String, Object>()
                : (Map<String, Object>) JSON.deserializeUntyped(body);

            Object result;
            if (request.requestURI.endsWith('/acquire')) {
                result = ALVScratchPoolService.acquire(payload);
            } else if (request.requestURI.endsWith('/heartbeat')) {
                result = ALVScratchPoolService.heartbeat(payload);
            } else if (request.requestURI.endsWith('/finalize')) {
                result = ALVScratchPoolService.finalizeLease(payload);
            } else if (request.requestURI.endsWith('/release')) {
                result = ALVScratchPoolService.releaseLease(payload);
            } else {
                response.statusCode = 404;
                response.responseBody = Blob.valueOf('{"ok":false,"message":"Unknown scratch pool route."}');
                return;
            }

            response.statusCode = 200;
            response.responseBody = Blob.valueOf(JSON.serialize(result));
        } catch (ALVScratchPoolService.PoolRequestException error) {
            String message = error.getMessage();
            Integer separator = message != null ? message.indexOf('|') : -1;
            Integer statusCode = 400;
            String detail = message;
            if (separator > 0) {
                statusCode = Integer.valueOf(message.substring(0, separator));
                detail = message.substring(separator + 1);
            }
            response.statusCode = statusCode;
            response.responseBody = Blob.valueOf('{"ok":false,"message":' + JSON.serialize(detail) + '}');
        } catch (Exception error) {
            response.statusCode = 500;
            response.responseBody = Blob.valueOf('{"ok":false,"message":' + JSON.serialize(error.getMessage()) + '}');
        }
    }
}
