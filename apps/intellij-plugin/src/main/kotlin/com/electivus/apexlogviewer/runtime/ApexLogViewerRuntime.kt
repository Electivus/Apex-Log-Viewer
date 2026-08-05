package com.electivus.apexlogviewer.runtime

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.LinkOption
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

data class LogListRequest(
    val workspaceRoot: Path,
    val username: String,
    val limit: Int = 50,
)

data class LogListRow(
    val id: String,
    val startTime: String? = null,
    val operation: String? = null,
    val status: String? = null,
    val logLength: Int? = null,
)

class ApexLogViewerRuntimeException(
    val code: String,
    message: String,
    cause: Throwable? = null,
) : RuntimeException(message, cause)

interface ApexLogViewerRuntime : AutoCloseable {
    suspend fun logStatus(request: LogStatusRequest): LogStatusResult

    suspend fun logList(request: LogListRequest): List<LogListRow>
}

private class DefaultApexLogViewerRuntime(
    @Suppress("unused") private val dependencies: RuntimeDependencies,
) : ApexLogViewerRuntime {
    override suspend fun logStatus(request: LogStatusRequest): LogStatusResult {
        val workspaceRoot = request.workspaceRoot
        requireAbsoluteWorkspace(workspaceRoot)

        val targetOrg = request.targetOrg?.trim().takeUnless { it.isNullOrEmpty() } ?: "default"
        val apexlogsRoot = workspaceRoot.resolve("apexlogs")
        val state = readSyncState(apexlogsRoot)
        val requested = request.targetOrg?.trim().orEmpty()
        val username = if (requested.isNotEmpty()) {
            localUsernameForSelector(apexlogsRoot, requested)
        } else {
            state.keys.sorted().firstOrNull()
        }
        val entry = username?.let(state::get)
        val resolvedTargetOrg = username ?: requested.ifEmpty { targetOrg }
        val logCount = try {
            if (requested.isNotEmpty() && username == null) 0 else countLocalLogs(apexlogsRoot, username)
        } catch (error: Exception) {
            throw ApexLogViewerRuntimeException(
                code = "local-persistence",
                message = "Local Apex logs could not be inspected.",
                cause = error,
            )
        }
        return LogStatusResult(
            targetOrg = resolvedTargetOrg,
            safeTargetOrg = safeTargetOrg(resolvedTargetOrg),
            workspaceRoot = workspaceRoot.toString(),
            apexlogsRoot = apexlogsRoot.toString(),
            stateFile = apexlogsRoot.resolve(".alv").resolve("sync-state.json").toString(),
            logCount = logCount,
            hasState = entry != null,
            lastSyncStartedAt = entry?.string("lastSyncStartedAt"),
            lastSyncCompletedAt = entry?.string("lastSyncCompletedAt"),
            lastSyncedLogId = entry?.string("lastSyncedLogId"),
            lastSyncedStartTime = entry?.string("lastSyncedStartTime"),
            downloadedCount = entry?.number("downloadedCount") ?: 0,
            cachedCount = (entry?.number("existingCount") ?: entry?.number("cachedCount") ?: 0) +
                (entry?.number("materializedCount") ?: 0),
        )
    }

    override suspend fun logList(request: LogListRequest): List<LogListRow> {
        requireAbsoluteWorkspace(request.workspaceRoot)
        val targetOrg = request.username.trim()
        if (targetOrg.isEmpty()) {
            throw ApexLogViewerRuntimeException("org-resolution", "A target org is required.")
        }
        val processResponse = try {
            dependencies.process.execute(
                ProcessRequest(
                    executable = "sf",
                    arguments = listOf("org", "display", "--target-org", targetOrg, "--json"),
                    cwd = request.workspaceRoot,
                ),
            )
        } catch (error: ApexLogViewerRuntimeException) {
            throw error
        } catch (error: Exception) {
            throw ApexLogViewerRuntimeException("org-resolution", "Salesforce org resolution failed.", error)
        }
        if (processResponse.exitCode != 0) {
            throw ApexLogViewerRuntimeException("org-resolution", "Salesforce org resolution failed.")
        }
        val connection = try {
            val envelope = JsonParser.parseString(processResponse.stdout).asJsonObject
            val result = envelope.getAsJsonObject("result")
            require(envelope.get("status")?.asInt == 0 && result != null)
            require(!result.string("username").isNullOrBlank())
            RuntimeConnection(
                instanceUrl = requireNotNull(result.string("instanceUrl")).trimEnd('/').also { require(it.isNotBlank()) },
                accessToken = requireNotNull(result.string("accessToken")).also { require(it.isNotBlank()) },
                apiVersion = result.string("apiVersion") ?: "63.0",
            )
        } catch (error: Exception) {
            throw ApexLogViewerRuntimeException("org-resolution", "Salesforce org resolution returned invalid data.", error)
        }
        val limit = request.limit.coerceIn(1, 200)
        val soql = "SELECT Id, StartTime, Operation, Status, LogLength FROM ApexLog " +
            "ORDER BY StartTime DESC, Id DESC LIMIT $limit"
        val encodedSoql = URLEncoder.encode(soql, StandardCharsets.UTF_8).replace("+", "%20")
        val httpResponse = try {
            dependencies.http.execute(
                HttpRequest(
                    method = "GET",
                    url = "${connection.instanceUrl}/services/data/v${connection.apiVersion}/tooling/query?q=$encodedSoql",
                    headers = mapOf("Authorization" to "Bearer ${connection.accessToken}"),
                ),
            )
        } catch (error: ApexLogViewerRuntimeException) {
            throw error
        } catch (error: Exception) {
            throw ApexLogViewerRuntimeException("remote-acquisition", "Salesforce Tooling request failed.", error)
        }
        if (httpResponse.status !in 200..299) {
            throw ApexLogViewerRuntimeException(
                "remote-acquisition",
                "Salesforce Tooling request failed with status ${httpResponse.status}.",
            )
        }
        return try {
            val records = JsonParser.parseString(httpResponse.body ?: "{}").asJsonObject
                .getAsJsonArray("records") ?: JsonArray()
            records.mapNotNull { element ->
                val record = element.asJsonObject
                val id = record.string("Id")?.takeIf(String::isNotBlank) ?: return@mapNotNull null
                LogListRow(
                    id = id,
                    startTime = record.string("StartTime"),
                    operation = record.string("Operation"),
                    status = record.string("Status"),
                    logLength = record.number("LogLength"),
                )
            }
        } catch (error: Exception) {
            throw ApexLogViewerRuntimeException("remote-acquisition", "Salesforce Tooling response was invalid.", error)
        }
    }

    override fun close() = Unit

    private fun requireAbsoluteWorkspace(workspaceRoot: Path) {
        if (!workspaceRoot.isAbsolute) {
            throw ApexLogViewerRuntimeException(
                code = "local-persistence",
                message = "Apex log workspace root must be an absolute path.",
            )
        }
    }

    private fun readSyncState(apexlogsRoot: Path): Map<String, JsonObject> {
        val stateFile = apexlogsRoot.resolve(".alv").resolve("sync-state.json")
        if (!Files.exists(stateFile, LinkOption.NOFOLLOW_LINKS)) return emptyMap()
        return try {
            val parsed = JsonParser.parseString(Files.readString(stateFile)).asJsonObject
            parsed.getAsJsonObject("orgs")?.entrySet()?.associate { (username, value) ->
                username to value.asJsonObject
            }.orEmpty()
        } catch (error: Exception) {
            throw ApexLogViewerRuntimeException(
                code = "local-persistence",
                message = "Apex log sync state could not be read locally.",
                cause = error,
            )
        }
    }

    private fun localUsernameForSelector(apexlogsRoot: Path, selector: String): String? {
        val matches = listDirectory(apexlogsRoot.resolve("orgs"))
            .asSequence()
            .filter(::isRealDirectory)
            .mapNotNull { readOrgMetadata(it.resolve("org.json")) }
            .filter { metadata -> selector == metadata.username || selector == metadata.alias }
            .map(OrgMetadata::username)
            .distinct()
            .toList()
        if (matches.size > 1) {
            throw ApexLogViewerRuntimeException(
                code = "org-resolution",
                message = "Org selector $selector matches more than one local org.",
            )
        }
        return matches.singleOrNull()
    }

    private fun readOrgMetadata(path: Path): OrgMetadata? = try {
        val parsed = JsonParser.parseString(Files.readString(path)).asJsonObject
        val version = parsed.get("version")?.takeUnless(JsonElement::isJsonNull)?.asInt
        val username = parsed.string("username") ?: parsed.string("resolvedUsername")
        if ((version != null && version != 1) || username.isNullOrBlank()) null else {
            OrgMetadata(username, parsed.string("alias"))
        }
    } catch (_: Exception) {
        null
    }

    private fun countLocalLogs(apexlogsRoot: Path, username: String?): Int {
        val ids = mutableSetOf<String>()
        fun collectCanonical(orgName: String) {
            val logsRoot = apexlogsRoot.resolve("orgs").resolve(safeStorageOrg(orgName)).resolve("logs")
            for (day in listDirectory(logsRoot)) {
                if (!isRealDirectory(day) || !LOG_DAY.matches(day.fileName.toString())) continue
                for (file in listDirectory(day)) {
                    val match = CANONICAL_LOG.matchEntire(file.fileName.toString())
                    if (match != null && Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) {
                        ids += match.groupValues[1]
                    }
                }
            }
        }
        if (username != null) {
            collectCanonical(username)
        } else {
            for (org in listDirectory(apexlogsRoot.resolve("orgs"))) {
                if (isRealDirectory(org)) collectCanonical(org.fileName.toString())
            }
        }
        val legacyPrefix = username?.let { "${safeStorageOrg(it)}_" }
        for (file in listDirectory(apexlogsRoot)) {
            if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) continue
            val name = file.fileName.toString()
            if (legacyPrefix != null && !name.startsWith(legacyPrefix)) continue
            LEGACY_LOG.find(name)?.groupValues?.get(1)?.let(ids::add)
        }
        return ids.size
    }

    private fun listDirectory(path: Path): List<Path> {
        if (!isRealDirectory(path)) return emptyList()
        return Files.newDirectoryStream(path).use { entries -> entries.toList() }
    }

    private fun isRealDirectory(path: Path): Boolean = Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)
}

private data class OrgMetadata(val username: String, val alias: String?)

private data class RuntimeConnection(
    val instanceUrl: String,
    val accessToken: String,
    val apiVersion: String,
)

private val LOG_DAY = Regex("^(unknown-date|\\d{4}-\\d{2}-\\d{2})$")
private val CANONICAL_LOG = Regex("^(07L[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?)\\.log$")
private val LEGACY_LOG = Regex("_(07L[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?)\\.log$")

private fun JsonObject.string(key: String): String? =
    get(key)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString

private fun JsonObject.number(key: String): Int? = try {
    get(key)?.takeUnless(JsonElement::isJsonNull)?.asDouble?.takeIf(Double::isFinite)?.toInt()
} catch (_: Exception) {
    null
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

private fun safeStorageOrg(value: String): String =
    safeTargetOrg(value).takeUnless { it == "." || it == ".." } ?: "default"
