package com.electivus.apexlogviewer.runtime

import java.nio.file.Files
import java.nio.file.Path
import junit.framework.TestCase
import kotlinx.coroutines.runBlocking

class ApexLogViewerRealOrgTest : TestCase() {
    fun testNativeRuntimeListsAndMaterializesTheSeededApexLog() = runBlocking {
        if (System.getenv("ALV_INTELLIJ_REAL_ORG_E2E") != "1") return@runBlocking
        val targetOrg = System.getenv("ALV_INTELLIJ_REAL_ORG_TARGET").orEmpty()
        val expectedLogId = System.getenv("ALV_INTELLIJ_REAL_ORG_LOG_ID").orEmpty()
        val workspaceValue = System.getenv("ALV_INTELLIJ_REAL_ORG_WORKSPACE").orEmpty()
        require(targetOrg.isNotBlank()) { "ALV_INTELLIJ_REAL_ORG_TARGET is required when real-org E2E is enabled" }
        require(APEX_LOG_ID_FOR_E2E.matches(expectedLogId)) {
            "ALV_INTELLIJ_REAL_ORG_LOG_ID must be a valid ApexLog ID when real-org E2E is enabled"
        }
        require(workspaceValue.isNotBlank()) {
            "ALV_INTELLIJ_REAL_ORG_WORKSPACE is required when real-org E2E is enabled"
        }

        val workspace = Path.of(workspaceValue).normalize()
        require(workspace.isAbsolute) {
            "ALV_INTELLIJ_REAL_ORG_WORKSPACE must be an absolute path when real-org E2E is enabled"
        }
        Files.createDirectories(workspace)
        val runtime = createApexLogViewerRuntime(defaultRuntimeDependencies())
        try {
            val orgs = runtime.orgList(OrgListRequest(workspace))
            assertTrue(orgs.any { it.alias == targetOrg || it.username == targetOrg })

            val page = runtime.logPage(LogPageRequest(workspace, targetOrg, limit = 50))
            val seeded = requireNotNull(page.logs.firstOrNull { it.id == expectedLogId }) {
                "seeded Apex log $expectedLogId was not returned by the native Tooling query"
            }
            val local = runtime.requireLocalLog(RequireLocalLogRequest(workspace, targetOrg, seeded))

            assertTrue(Files.isRegularFile(local.localPath))
            assertTrue(hasBoundedApexLogMarker(local.localPath))
            assertTrue(runtime.parseLog(ParseLogRequest(local.localPath)).isNotEmpty())
        } finally {
            runtime.close()
        }
    }

    companion object {
        private val APEX_LOG_ID_FOR_E2E = Regex("^07L[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$")
    }
}
