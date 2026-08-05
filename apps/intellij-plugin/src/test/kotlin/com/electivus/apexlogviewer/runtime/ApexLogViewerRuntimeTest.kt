package com.electivus.apexlogviewer.runtime

import java.nio.file.Files
import java.nio.file.Path
import java.util.Comparator
import junit.framework.TestCase
import kotlinx.coroutines.runBlocking

class ApexLogViewerRuntimeTest : TestCase() {
    fun testProcessBoundaryFailuresAreClassifiedAtThePublicFacade() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-process-failure-")
        val runtime = createApexLogViewerRuntime(
            RuntimeDependencies(
                process = RuntimeProcess { error("process transport detail") },
                http = RuntimeHttp { error("HTTP must not run") },
            ),
        )
        try {
            val failure = captureFailure {
                runtime.logList(LogListRequest(workspaceRoot, "demo@example.com", 2))
            }
            assertEquals("org-resolution", failure.code)
            assertEquals("Salesforce org resolution failed.", failure.message)
        } finally {
            runtime.close()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testHttpBoundaryFailuresAreClassifiedAtThePublicFacade() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-http-failure-")
        val runtime = createApexLogViewerRuntime(
            RuntimeDependencies(
                process = RuntimeProcess {
                    ProcessResponse(
                        exitCode = 0,
                        stdout =
                            """{"status":0,"result":{"username":"demo@example.com","instanceUrl":"https://example.my.salesforce.com","accessToken":"test-token","apiVersion":"63.0"}}""",
                        stderr = "",
                    )
                },
                http = RuntimeHttp { error("network transport detail") },
            ),
        )
        try {
            val failure = captureFailure {
                runtime.logList(LogListRequest(workspaceRoot, "demo@example.com", 2))
            }
            assertEquals("remote-acquisition", failure.code)
            assertEquals("Salesforce Tooling request failed.", failure.message)
        } finally {
            runtime.close()
            deleteRecursively(workspaceRoot)
        }
    }

    private suspend fun captureFailure(operation: suspend () -> Unit): ApexLogViewerRuntimeException {
        val failure = runCatching { operation() }.exceptionOrNull()
        assertTrue("expected ApexLogViewerRuntimeException but got $failure", failure is ApexLogViewerRuntimeException)
        return failure as ApexLogViewerRuntimeException
    }

    private fun deleteRecursively(root: Path) {
        Files.walk(root).use { paths -> paths.sorted(Comparator.reverseOrder()).forEach(Files::deleteIfExists) }
    }
}
