package com.electivus.apexlogviewer.project

import com.google.gson.GsonBuilder
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ApplicationInfo
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.SystemInfo
import java.net.JarURLConnection
import java.time.Instant
import java.util.ArrayDeque

data class OperationalDiagnostic(
    val timestamp: String,
    val phase: String,
    val outcome: String,
    val code: String? = null,
)

@Service(Service.Level.PROJECT)
class ApexLogViewerDiagnostics {
    private val records = ArrayDeque<OperationalDiagnostic>()

    fun record(phase: String, outcome: String, code: String? = null) {
        require(phase in ALLOWED_PHASES) { "unsupported diagnostic phase" }
        require(outcome in ALLOWED_OUTCOMES) { "unsupported diagnostic outcome" }
        val sanitizedCode = code?.let { if (it in ALLOWED_CODES) it else REDACTED_CODE }
        synchronized(records) {
            if (records.size == MAX_RECORDS) records.removeFirst()
            records.addLast(OperationalDiagnostic(Instant.now().toString(), phase, outcome, sanitizedCode))
        }
        if (traceLoggingEnabled()) {
            LOGGER.info(
                buildString {
                    append("phase=").append(phase).append(" outcome=").append(outcome)
                    sanitizedCode?.let { append(" code=").append(it) }
                },
            )
        }
    }

    fun sanitizedPackage(project: Project, state: LogsProjectState): String {
        val snapshot = synchronized(records) { records.toList() }
        val root = JsonObject().apply {
            addProperty("schemaVersion", 1)
            addProperty("pluginVersion", pluginVersion())
            addProperty("ideVersion", ApplicationInfo.getInstance().fullVersion)
            addProperty("os", "${SystemInfo.OS_NAME} ${SystemInfo.OS_VERSION}".trim())
            addProperty("javaVersion", System.getProperty("java.version").orEmpty())
            add(
                "capabilities",
                JsonObject().apply {
                    addProperty("hasProjectBase", project.basePath != null)
                    addProperty("hasSalesforceProject", project.basePath?.let { java.nio.file.Path.of(it).resolve("sfdx-project.json").toFile().isFile } == true)
                    addProperty("illuminatedCloudActionAvailable", com.intellij.openapi.actionSystem.ActionManager.getInstance().getAction("IlluminatedCloud.LogAnalyzer.Open") != null)
                },
            )
            add(
                "lifecycle",
                JsonObject().apply {
                    addProperty("catalogCount", state.logs.size)
                    addProperty("searchMatchCount", state.search.matches.size)
                    addProperty("pendingBodyCount", state.search.pendingLogIds.size)
                    addProperty("partialFailureCount", state.search.partialFailureCount + state.downloadFailureCount)
                    addProperty("isBusy", state.isRefreshing || state.isLoadingMore || state.isDownloadingAll || state.search.isSearching)
                },
            )
            add(
                "events",
                JsonArray().apply {
                    snapshot.forEach { event ->
                        add(
                            JsonObject().apply {
                                addProperty("timestamp", event.timestamp)
                                addProperty("phase", event.phase)
                                addProperty("outcome", event.outcome)
                                event.code?.let { addProperty("code", it) }
                            },
                        )
                    }
                },
            )
        }
        return GsonBuilder().setPrettyPrinting().create().toJson(root)
    }

    private fun pluginVersion(): String = runCatching {
        val resource = ApexLogViewerDiagnostics::class.java.getResource("ApexLogViewerDiagnostics.class")
        val connection = resource?.openConnection() as? JarURLConnection
        connection?.manifest?.mainAttributes?.getValue("Version")
    }.getOrNull() ?: "development"

    private fun traceLoggingEnabled(): Boolean = runCatching {
        val application = ApplicationManager.getApplication()
        !application.isDisposed && application.service<ApexLogViewerApplicationSettings>().traceLogging
    }.getOrDefault(false)

    companion object {
        private const val MAX_RECORDS = 200
        private const val REDACTED_CODE = "redacted"
        private val LOGGER = Logger.getInstance(ApexLogViewerDiagnostics::class.java)
        private val ALLOWED_PHASES =
            setOf("refresh", "pagination", "search", "download", "acquisition", "materialization", "retention")
        private val ALLOWED_OUTCOMES = setOf("started", "completed", "cancelled", "partial", "failed")
        private val ALLOWED_CODES = setOf(
            "invalid-log",
            "local-persistence",
            "local-read",
            "no-authenticated-orgs",
            "org-resolution",
            "remote-acquisition",
            "unexpected",
        )
    }
}
