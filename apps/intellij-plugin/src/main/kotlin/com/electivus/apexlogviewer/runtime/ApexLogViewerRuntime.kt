package com.electivus.apexlogviewer.runtime

import java.nio.file.Files
import java.nio.file.Path

data class LogStatusRequest(
    val workspaceRoot: Path,
    val targetOrg: String? = null,
)

data class LogStatusResult(
    val targetOrg: String,
    val safeTargetOrg: String,
    val workspaceRoot: String,
    val apexlogsRoot: String,
    val stateFile: String,
    val logCount: Int,
    val hasState: Boolean,
    val lastSyncStartedAt: String? = null,
    val lastSyncCompletedAt: String? = null,
    val lastSyncedLogId: String? = null,
    val lastSyncedStartTime: String? = null,
    val downloadedCount: Int = 0,
    val cachedCount: Int = 0,
)

class ApexLogViewerRuntimeException(
    val code: String,
    message: String,
    cause: Throwable? = null,
) : RuntimeException(message, cause)

interface ApexLogViewerRuntime : AutoCloseable {
    suspend fun logStatus(request: LogStatusRequest): LogStatusResult
}

private class DefaultApexLogViewerRuntime(
    @Suppress("unused") private val dependencies: RuntimeDependencies,
) : ApexLogViewerRuntime {
    override suspend fun logStatus(request: LogStatusRequest): LogStatusResult {
        val workspaceRoot = request.workspaceRoot
        if (!workspaceRoot.isAbsolute) {
            throw ApexLogViewerRuntimeException(
                code = "local-persistence",
                message = "Apex log workspace root must be an absolute path.",
            )
        }

        val targetOrg = request.targetOrg?.trim().takeUnless { it.isNullOrEmpty() } ?: "default"
        val apexlogsRoot = workspaceRoot.resolve("apexlogs")
        val logCount = countLocalLogs(apexlogsRoot)
        return LogStatusResult(
            targetOrg = targetOrg,
            safeTargetOrg = safeTargetOrg(targetOrg),
            workspaceRoot = workspaceRoot.toString(),
            apexlogsRoot = apexlogsRoot.toString(),
            stateFile = apexlogsRoot.resolve(".alv").resolve("sync-state.json").toString(),
            logCount = logCount,
            hasState = false,
        )
    }

    override fun close() = Unit

    private fun countLocalLogs(apexlogsRoot: Path): Int {
        if (!Files.isDirectory(apexlogsRoot)) return 0
        return try {
            Files.walk(apexlogsRoot).use { paths ->
                paths.filter { Files.isRegularFile(it) && it.fileName.toString().endsWith(".log") }.count().toInt()
            }
        } catch (error: Exception) {
            throw ApexLogViewerRuntimeException(
                code = "local-persistence",
                message = "Local Apex logs could not be inspected.",
                cause = error,
            )
        }
    }
}

private val rejectingProcess = RuntimeProcess {
    throw ApexLogViewerRuntimeException("UNEXPECTED_EXTERNAL_CALL", "The runtime process boundary is not configured.")
}

private val rejectingHttp = RuntimeHttp {
    throw ApexLogViewerRuntimeException("UNEXPECTED_EXTERNAL_CALL", "The runtime HTTP boundary is not configured.")
}

fun createApexLogViewerRuntime(): ApexLogViewerRuntime =
    createApexLogViewerRuntime(RuntimeDependencies(rejectingProcess, rejectingHttp))

fun createApexLogViewerRuntime(dependencies: RuntimeDependencies): ApexLogViewerRuntime =
    DefaultApexLogViewerRuntime(dependencies)

private fun safeTargetOrg(value: String): String =
    value.replace(Regex("[^a-zA-Z0-9_.@-]+"), "_").ifEmpty { "default" }
