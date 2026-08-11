package com.electivus.apexlogviewer.runtime

import com.sun.jna.Memory
import com.sun.jna.Native
import com.sun.jna.platform.win32.Kernel32
import com.sun.jna.platform.win32.WinBase
import com.sun.jna.platform.win32.WinNT
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.IOException
import java.math.BigDecimal
import java.net.URI
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.FileAlreadyExistsException
import java.nio.file.LinkOption
import java.nio.file.NoSuchFileException
import java.nio.file.Path
import java.nio.file.SecureDirectoryStream
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.BasicFileAttributes
import java.nio.file.attribute.BasicFileAttributeView
import java.nio.file.StandardCopyOption
import java.time.Duration
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.LinkedHashMap
import java.util.Locale
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

data class LogStatusRequest(
    val workspaceRoot: Path,
    val targetOrg: String? = null,
)

data class OrgListRequest(
    val workspaceRoot: Path,
)

data class OrgListItem(
    val username: String,
    val alias: String? = null,
    val isDefaultUsername: Boolean = false,
    val isDefaultDevHubUsername: Boolean = false,
    val isScratchOrg: Boolean = false,
    val instanceUrl: String? = null,
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

data class LogListRow @JvmOverloads constructor(
    val id: String,
    val startTime: String? = null,
    val operation: String? = null,
    val status: String? = null,
    val logLength: Int? = null,
    val logUser: String? = null,
    val application: String? = null,
)

data class LogCursor(
    val beforeStartTime: String,
    val beforeId: String,
    val sortValue: String? = beforeStartTime,
    val sortField: LogPageSortField = LogPageSortField.START_TIME,
    val sortDirection: LogPageSortDirection = LogPageSortDirection.DESCENDING,
    val snapshotMaxStartTime: String? = null,
)

enum class LogPageSortField {
    START_TIME,
    OPERATION,
    STATUS,
    SIZE,
    LOG_ID,
}

enum class LogPageSortDirection {
    ASCENDING,
    DESCENDING,
}

data class LogPageRequest(
    val workspaceRoot: Path,
    val username: String,
    val limit: Int = 50,
    val cursor: LogCursor? = null,
    val sortField: LogPageSortField = LogPageSortField.START_TIME,
    val sortDirection: LogPageSortDirection = LogPageSortDirection.DESCENDING,
)

data class LogPageResult(
    val logs: List<LogListRow>,
    val nextCursor: LogCursor? = null,
)

data class RequireLocalLogRequest(
    val workspaceRoot: Path,
    val targetOrg: String,
    val log: LogListRow,
)

data class LocalLogFile(
    val logId: String,
    val startTime: String? = null,
    val resolvedUsername: String,
    val source: String,
    val persistence: String,
    val localPath: Path,
)

data class LocalLogSearchRequest @JvmOverloads constructor(
    val workspaceRoot: Path,
    val username: String,
    val query: String,
    val logs: List<LogListRow>,
    val concurrency: Int = 4,
)

data class MatchRange(
    val start: Int,
    val endExclusive: Int,
)

data class LogSearchMatch(
    val logId: String,
    val source: String,
    val snippet: String? = null,
    val ranges: List<MatchRange> = emptyList(),
)

data class LocalLogSearchResult(
    val matches: List<LogSearchMatch>,
    val pendingLogIds: List<String>,
    val failedLogIds: List<String> = emptyList(),
)

data class ParseLogRequest(
    val localPath: Path,
)

enum class LogCategory {
    DEBUG,
    SOQL,
    DML,
    CODE,
    LIMIT,
    SYSTEM,
    ERROR,
    OTHER,
}

data class ParsedLogEntry(
    val id: Int,
    val timestamp: String,
    val elapsed: String? = null,
    val type: String,
    val lineNumber: Int? = null,
    val message: String,
    val details: String? = null,
    val raw: String,
    val category: LogCategory,
)

data class LogDiagnostic(
    val code: String,
    val severity: String,
    val summary: String,
    val line: Int? = null,
    val eventType: String? = null,
)

data class LogTriageSummary(
    val hasErrors: Boolean,
    val primaryReason: String? = null,
    val reasons: List<LogDiagnostic>,
)

enum class PurgeDeletionOutcome {
    DELETED,
    PROTECTED,
    MISSING,
}

fun interface PurgeDeletionGuard {
    fun deleteIfUnprotected(logId: String, delete: () -> Boolean): PurgeDeletionOutcome
}

data class PurgeLocalLogsRequest(
    val workspaceRoot: Path,
    val protectedLogIds: Set<String> = emptySet(),
    val retentionHours: Long = 24,
    val deletionGuard: PurgeDeletionGuard = PurgeDeletionGuard { _, delete ->
        if (delete()) PurgeDeletionOutcome.DELETED else PurgeDeletionOutcome.MISSING
    },
)

data class PurgeLocalLogsResult(
    val deleted: Int,
    val retained: Int,
    val failed: Int,
)

data class SyncStateUpdateRequest(
    val workspaceRoot: Path,
    val username: String,
    val startedAt: String,
    val completedAt: String,
    val newestLog: LogListRow?,
    val existingCount: Int,
    val materializedCount: Int,
    val downloadedCount: Int,
    val failedCount: Int,
)

class ApexLogViewerRuntimeException(
    val code: String,
    message: String,
    cause: Throwable? = null,
) : RuntimeException(message, cause)

private data class LocalSearchOutcome(
    val logId: String,
    val match: LogSearchMatch? = null,
    val pending: Boolean = false,
    val failed: Boolean = false,
)

private data class LocalSearchCacheKey(
    val path: Path,
    val size: Long,
    val modifiedAtMillis: Long,
)

private class CachedBodySearch {
    val matches = LinkedHashMap<String, String?>(LOCAL_SEARCH_CACHE_QUERIES_PER_FILE + 1, 0.75f, true)
}

private const val LOCAL_SEARCH_CACHE_FILES = 32
private const val LOCAL_SEARCH_CACHE_QUERIES_PER_FILE = 16

interface ApexLogViewerRuntime : AutoCloseable {
    suspend fun orgList(request: OrgListRequest): List<OrgListItem>

    suspend fun logStatus(request: LogStatusRequest): LogStatusResult

    suspend fun logList(request: LogListRequest): List<LogListRow>

    suspend fun logPage(request: LogPageRequest): LogPageResult

    suspend fun findLocalLog(request: RequireLocalLogRequest): LocalLogFile?

    suspend fun requireLocalLog(request: RequireLocalLogRequest): LocalLogFile

    suspend fun searchLocalLogs(request: LocalLogSearchRequest): LocalLogSearchResult

    suspend fun parseLog(request: ParseLogRequest): List<ParsedLogEntry>

    suspend fun triageLog(request: ParseLogRequest): LogTriageSummary

    suspend fun purgeLocalLogs(request: PurgeLocalLogsRequest): PurgeLocalLogsResult

    suspend fun updateSyncState(request: SyncStateUpdateRequest)
}

private class DefaultApexLogViewerRuntime(
    @Suppress("unused") private val dependencies: RuntimeDependencies,
    private val syncStateLockWaitTimeout: Duration,
) : ApexLogViewerRuntime {
    private val localSearchCache = object : LinkedHashMap<LocalSearchCacheKey, CachedBodySearch>(
        LOCAL_SEARCH_CACHE_FILES + 1,
        0.75f,
        true,
    ) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<LocalSearchCacheKey, CachedBodySearch>?): Boolean =
            size > LOCAL_SEARCH_CACHE_FILES
    }

    override suspend fun orgList(request: OrgListRequest): List<OrgListItem> {
        requireAbsoluteWorkspace(request.workspaceRoot)
        val processResponse = try {
            dependencies.process.execute(
                ProcessRequest(
                    executable = "sf",
                    arguments = listOf("org", "list", "--json"),
                    cwd = request.workspaceRoot,
                    environment = SALESFORCE_CLI_ENVIRONMENT,
                ),
            )
        } catch (error: kotlinx.coroutines.CancellationException) {
            throw error
        } catch (error: ApexLogViewerRuntimeException) {
            throw error
        } catch (error: Exception) {
            throw ApexLogViewerRuntimeException("org-resolution", "Salesforce org discovery failed.", error)
        }
        if (processResponse.exitCode != 0) {
            throw ApexLogViewerRuntimeException("org-resolution", "Salesforce org discovery failed.")
        }
        return try {
            val envelope = parseSalesforceCliJsonObject(processResponse.stdout)
            val status = envelope.get("status")?.takeUnless(JsonElement::isJsonNull)?.asInt
            require(status == null || status == 0)
            val result = envelope.getAsJsonObject("result") ?: envelope
            val deduplicated = linkedMapOf<String, OrgListItem>()
            ORG_LIST_ARRAY_KEYS.forEach { key ->
                result.getAsJsonArray(key)?.forEach { element ->
                    val org = element.asJsonObject
                    val username = org.string("username")?.trim()?.takeIf(String::isNotEmpty)
                        ?: return@forEach
                    deduplicated.putIfAbsent(
                        username,
                        OrgListItem(
                            username = username,
                            alias = org.string("alias")?.trim()?.takeIf(String::isNotEmpty),
                            isDefaultUsername = org.boolean("isDefaultUsername"),
                            isDefaultDevHubUsername = org.boolean("isDefaultDevHubUsername"),
                            isScratchOrg = org.boolean("isScratchOrg"),
                            instanceUrl = org.string("instanceUrl")?.trim()?.takeIf(String::isNotEmpty),
                        ),
                    )
                }
            }
            deduplicated.values.sortedWith(
                compareByDescending<OrgListItem> { it.isDefaultUsername }
                    .thenBy(String.CASE_INSENSITIVE_ORDER) { it.alias ?: it.username },
            )
        } catch (error: Exception) {
            throw ApexLogViewerRuntimeException(
                "org-resolution",
                "Salesforce org discovery returned invalid data.",
                error,
            )
        }
    }

    override suspend fun logStatus(request: LogStatusRequest): LogStatusResult {
        val workspaceRoot = request.workspaceRoot
        requireAbsoluteWorkspace(workspaceRoot)

        val targetOrg = request.targetOrg?.trim().takeUnless { it.isNullOrEmpty() } ?: "default"
        val apexlogsRoot = workspaceRoot.resolve("apexlogs")
        val state = readSyncState(workspaceRoot, apexlogsRoot)
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

    override suspend fun logList(request: LogListRequest): List<LogListRow> =
        logPage(LogPageRequest(request.workspaceRoot, request.username, request.limit)).logs

    override suspend fun logPage(request: LogPageRequest): LogPageResult {
        requireAbsoluteWorkspace(request.workspaceRoot)
        val targetOrg = request.username.trim()
        if (targetOrg.isEmpty()) {
            throw ApexLogViewerRuntimeException("org-resolution", "A target org is required.")
        }
        val cursor = request.cursor
        if (cursor != null && !isValidLogCursor(cursor, request)) {
            throw ApexLogViewerRuntimeException("remote-acquisition", "The Apex log page cursor is invalid.")
        }
        val limit = request.limit.coerceIn(1, 200)
        val snapshotMaxStartTime = cursor?.snapshotMaxStartTime ?: if (request.requiresSnapshotWatermark()) {
            Instant.now(dependencies.clock).truncatedTo(ChronoUnit.MILLIS).toString()
        } else {
            null
        }
        val predicates = buildList {
            snapshotMaxStartTime?.let { add("StartTime <= $it") }
            cursor?.let { add(keysetWhereClause(it)) }
        }
        val where = predicates.takeIf { it.isNotEmpty() }?.joinToString(" AND ", " WHERE ").orEmpty()
        val direction = if (request.sortDirection == LogPageSortDirection.ASCENDING) "ASC" else "DESC"
        val orderBy = if (request.sortField == LogPageSortField.LOG_ID) {
            "Id $direction"
        } else {
            val field = request.sortField.soqlField()
            val nulls = if (request.sortDirection == LogPageSortDirection.ASCENDING) "NULLS FIRST" else "NULLS LAST"
            "$field $direction $nulls, Id $direction"
        }
        val soql = "SELECT Id, StartTime, Operation, Application, Status, LogLength, LogUser.Name FROM ApexLog$where " +
            "ORDER BY $orderBy LIMIT $limit"
        val encodedSoql = URLEncoder.encode(soql, StandardCharsets.UTF_8).replace("+", "%20")
        val authenticated = executeAuthenticatedHttp(
            request.workspaceRoot,
            targetOrg,
            "Salesforce Tooling request failed.",
        ) { connection ->
                HttpRequest(
                    method = "GET",
                    url = "${connection.instanceUrl}/services/data/v${connection.apiVersion}/tooling/query?q=$encodedSoql",
                    headers = mapOf("Authorization" to "Bearer ${connection.accessToken}"),
                )
        }
        val httpResponse = authenticated.response
        if (httpResponse.status !in 200..299) {
            throw ApexLogViewerRuntimeException(
                "remote-acquisition",
                "Salesforce Tooling request failed with status ${httpResponse.status}.",
            )
        }
        return try {
            val records = JsonParser.parseString(httpResponse.body ?: "{}").asJsonObject
                .getAsJsonArray("records") ?: JsonArray()
            val logs = records.mapNotNull { element ->
                val record = element.asJsonObject
                val id = record.string("Id")?.takeIf(String::isNotBlank) ?: return@mapNotNull null
                LogListRow(
                    id = id,
                    startTime = record.string("StartTime"),
                    operation = record.string("Operation"),
                    application = record.string("Application"),
                    status = record.string("Status"),
                    logLength = record.number("LogLength"),
                    logUser = record.getAsJsonObject("LogUser")?.string("Name"),
                )
            }
            val last = logs.lastOrNull()
            LogPageResult(
                logs = logs,
                nextCursor = if (logs.size == limit && last != null) {
                    LogCursor(
                        beforeStartTime = last.startTime.orEmpty(),
                        beforeId = last.id,
                        sortValue = last.sortValue(request.sortField),
                        sortField = request.sortField,
                        sortDirection = request.sortDirection,
                        snapshotMaxStartTime = snapshotMaxStartTime,
                    )
                } else {
                    null
                },
            )
        } catch (error: Exception) {
            throw ApexLogViewerRuntimeException("remote-acquisition", "Salesforce Tooling response was invalid.", error)
        }
    }

    override suspend fun findLocalLog(request: RequireLocalLogRequest): LocalLogFile? {
        requireAbsoluteWorkspace(request.workspaceRoot)
        val targetOrg = request.targetOrg.trim()
        if (targetOrg.isEmpty()) {
            throw ApexLogViewerRuntimeException("org-resolution", "A target org is required.")
        }
        if (!APEX_LOG_ID.matches(request.log.id)) {
            throw ApexLogViewerRuntimeException("invalid-log", "The Apex log ID is invalid.")
        }
        val apexlogsRoot = request.workspaceRoot.resolve("apexlogs")
        ensureSafeWorkspacePath(request.workspaceRoot, apexlogsRoot)
        val localUsername = localUsernameForSelector(apexlogsRoot, targetOrg) ?: targetOrg
        val localPath = findLifecycleLogPath(request.workspaceRoot, localUsername, request.log) ?: return null
        return LocalLogFile(
            request.log.id,
            request.log.startTime,
            localUsername,
            "local",
            "existing",
            localPath,
        )
    }

    override suspend fun requireLocalLog(request: RequireLocalLogRequest): LocalLogFile {
        findLocalLog(request)?.let { return it }
        val targetOrg = request.targetOrg.trim()
        val connection = resolveConnection(request.workspaceRoot, targetOrg)
        val day = request.log.startTime?.take(10)?.takeIf(LOG_DAY_DATE::matches) ?: "unknown-date"
        val localPath = request.workspaceRoot
            .resolve("apexlogs")
            .resolve("orgs")
            .resolve(safeStorageOrg(connection.username))
            .resolve("logs")
            .resolve(day)
            .resolve("${request.log.id}.log")
        ensureSafeWorkspacePath(request.workspaceRoot, localPath)
        if (Files.isRegularFile(localPath, LinkOption.NOFOLLOW_LINKS)) {
            return LocalLogFile(
                request.log.id,
                request.log.startTime,
                connection.username,
                "local",
                "existing",
                localPath,
            )
        }
        val authenticated = executeAuthenticatedHttp(
            request.workspaceRoot,
            targetOrg,
            "Apex log ${request.log.id} could not be acquired from Salesforce.",
            connection,
        ) { activeConnection ->
                HttpRequest(
                    method = "GET",
                    url = "${activeConnection.instanceUrl}/services/data/v${activeConnection.apiVersion}/tooling/sobjects/ApexLog/${request.log.id}/Body",
                    headers = mapOf("Authorization" to "Bearer ${activeConnection.accessToken}"),
                )
        }
        val httpResponse = authenticated.response
        if (httpResponse.status !in 200..299) {
            throw ApexLogViewerRuntimeException(
                "remote-acquisition",
                "Apex log ${request.log.id} could not be acquired from Salesforce.",
            )
        }
        try {
            ensureWorkspaceLogIgnore(request.workspaceRoot)
            writeOrgMetadata(request.workspaceRoot, authenticated.connection)
            val written = writeFileAtomicIfAbsent(request.workspaceRoot, localPath, httpResponse.body.orEmpty())
            return LocalLogFile(
                request.log.id,
                request.log.startTime,
                authenticated.connection.username,
                if (written) "remote" else "local",
                if (written) "written" else "existing",
                localPath,
            )
        } catch (error: ApexLogViewerRuntimeException) {
            throw error
        } catch (error: Exception) {
            throw ApexLogViewerRuntimeException(
                "local-persistence",
                "Apex log ${request.log.id} could not be materialized locally.",
                error,
            )
        }
    }

    override suspend fun searchLocalLogs(request: LocalLogSearchRequest): LocalLogSearchResult {
        requireAbsoluteWorkspace(request.workspaceRoot)
        val query = request.query
        if (query.isEmpty()) return LocalLogSearchResult(emptyList(), emptyList())
        val semaphore = Semaphore(request.concurrency.coerceIn(1, 16))
        val outcomes = coroutineScope {
            request.logs.map { log ->
                async(Dispatchers.IO) {
                    semaphore.withPermit {
                        try {
                            searchOneLocalLog(request, log, query)
                        } catch (error: kotlinx.coroutines.CancellationException) {
                            throw error
                        } catch (_: Exception) {
                            LocalSearchOutcome(log.id, failed = true)
                        }
                    }
                }
            }.awaitAll()
        }
        return LocalLogSearchResult(
            matches = outcomes.mapNotNull(LocalSearchOutcome::match),
            pendingLogIds = outcomes.filter(LocalSearchOutcome::pending).map(LocalSearchOutcome::logId),
            failedLogIds = outcomes.filter(LocalSearchOutcome::failed).map(LocalSearchOutcome::logId),
        )
    }

    private suspend fun searchOneLocalLog(
        request: LocalLogSearchRequest,
        log: LogListRow,
        query: String,
    ): LocalSearchOutcome {
        if (!APEX_LOG_ID.matches(log.id)) return LocalSearchOutcome(log.id)
        val matchingMetadata = listOfNotNull(
            log.id,
            log.startTime,
            log.operation,
            log.application,
            log.status,
            log.logLength?.toString(),
            log.logUser,
        ).firstOrNull { value -> value.contains(query, ignoreCase = true) }
        if (matchingMetadata != null) {
            val start = matchingMetadata.indexOf(query, ignoreCase = true)
            return LocalSearchOutcome(
                log.id,
                match = LogSearchMatch(
                    logId = log.id,
                    source = "metadata",
                    snippet = matchingMetadata,
                    ranges = listOf(MatchRange(start, start + query.length)),
                ),
            )
        }
        val localPath = findLifecycleLogPath(request.workspaceRoot, request.username, log)
            ?: return LocalSearchOutcome(log.id, pending = true)
        val line = cachedFirstMatchingLine(localPath, query)
        val match = line?.let {
            val start = it.indexOf(query, ignoreCase = true)
            LogSearchMatch(
                logId = log.id,
                source = "body",
                snippet = it,
                ranges = listOf(MatchRange(start, start + query.length)),
            )
        }
        return LocalSearchOutcome(log.id, match)
    }

    private suspend fun cachedFirstMatchingLine(path: Path, query: String): String? {
        currentCoroutineContext().ensureActive()
        val attributes = Files.readAttributes(path, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
        val key = LocalSearchCacheKey(path.toAbsolutePath().normalize(), attributes.size(), attributes.lastModifiedTime().toMillis())
        val normalizedQuery = query.lowercase(Locale.ROOT)
        synchronized(localSearchCache) {
            localSearchCache[key]?.let { cached ->
                if (cached.matches.containsKey(normalizedQuery)) return cached.matches[normalizedQuery]
            }
        }
        val context = currentCoroutineContext()
        val line = Files.newBufferedReader(path, StandardCharsets.UTF_8).useLines { lines ->
            lines.firstOrNull {
                context.ensureActive()
                it.contains(query, ignoreCase = true)
            }
        }
        synchronized(localSearchCache) {
            val cached = localSearchCache.getOrPut(key, ::CachedBodySearch)
            cached.matches[normalizedQuery] = line
            while (cached.matches.size > LOCAL_SEARCH_CACHE_QUERIES_PER_FILE) {
                cached.matches.entries.iterator().apply {
                    next()
                    remove()
                }
            }
        }
        return line
    }

    override suspend fun parseLog(request: ParseLogRequest): List<ParsedLogEntry> {
        if (!request.localPath.isAbsolute || !Files.isRegularFile(request.localPath, LinkOption.NOFOLLOW_LINKS)) {
            throw ApexLogViewerRuntimeException("local-read", "The local Apex log is not a readable regular file.")
        }
        return try {
            val context = currentCoroutineContext()
            context.ensureActive()
            val entries = mutableListOf<ParsedLogEntry>()
            Files.newBufferedReader(request.localPath, StandardCharsets.UTF_8).useLines { lines ->
                lines.forEachIndexed { index, raw ->
                    context.ensureActive()
                    val previous = entries.lastOrNull()
                    if (previous?.category == LogCategory.DEBUG && !APEX_EVENT_LINE.containsMatchIn(raw.trimEnd())) {
                        entries[entries.lastIndex] = previous.copy(
                            message = "${previous.message}\n${raw.trimEnd()}",
                            raw = "${previous.raw}\n$raw",
                        )
                    } else {
                        parseLogLine(raw, index)?.let(entries::add)
                    }
                }
            }
            context.ensureActive()
            entries
        } catch (error: CancellationException) {
            throw error
        } catch (error: ApexLogViewerRuntimeException) {
            throw error
        } catch (error: Exception) {
            throw ApexLogViewerRuntimeException("local-read", "The local Apex log could not be parsed.", error)
        }
    }

    override suspend fun triageLog(request: ParseLogRequest): LogTriageSummary {
        if (!request.localPath.isAbsolute || !Files.isRegularFile(request.localPath, LinkOption.NOFOLLOW_LINKS)) {
            throw ApexLogViewerRuntimeException("local-read", "The local Apex log is not a readable regular file.")
        }
        return try {
            summarizeLogText(readLogTextCancellable(request.localPath))
        } catch (error: CancellationException) {
            throw error
        } catch (error: ApexLogViewerRuntimeException) {
            throw error
        } catch (error: Exception) {
            throw ApexLogViewerRuntimeException("local-read", "The local Apex log could not be triaged.", error)
        }
    }

    override suspend fun purgeLocalLogs(request: PurgeLocalLogsRequest): PurgeLocalLogsResult {
        requireAbsoluteWorkspace(request.workspaceRoot)
        if (request.retentionHours < 1) {
            throw ApexLogViewerRuntimeException("local-persistence", "Apex log retention must be at least one hour.")
        }
        val protected = request.protectedLogIds.filterTo(mutableSetOf(), APEX_LOG_ID::matches)
        val context = currentCoroutineContext()
        context.ensureActive()
        val cutoff = Instant.now(dependencies.clock).minusSeconds(request.retentionHours * 60 * 60)
        val apexlogsRoot = request.workspaceRoot.resolve("apexlogs")
        ensureSafeWorkspacePath(request.workspaceRoot, apexlogsRoot)
        if (!Files.isDirectory(apexlogsRoot, LinkOption.NOFOLLOW_LINKS)) {
            return PurgeLocalLogsResult(0, 0, 0)
        }
        var deleted = 0
        var retained = 0
        var failed = 0
        val candidates = try {
            Files.walk(apexlogsRoot).use { paths ->
                paths.peek { context.ensureActive() }
                    .filter { Files.isRegularFile(it, LinkOption.NOFOLLOW_LINKS) }
                    .toList()
                    .mapNotNull { path ->
                        context.ensureActive()
                        managedLifecycleLogId(request.workspaceRoot, path)?.takeIf { logId ->
                            managedPurgePathSegments(request.workspaceRoot, path, logId) != null
                        }?.let { it to path }
                    }
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            throw ApexLogViewerRuntimeException("local-persistence", "Local Apex logs could not be inspected for retention.", error)
        }
        candidates.forEach { (logId, path) ->
            try {
                context.ensureActive()
                if (
                    logId in protected ||
                    !Files.getLastModifiedTime(path, LinkOption.NOFOLLOW_LINKS).toInstant().isBefore(cutoff)
                ) {
                    retained += 1
                } else {
                    context.ensureActive()
                    var deleteAttempted = false
                    var deleteResult: Boolean? = null
                    val outcome = request.deletionGuard.deleteIfUnprotected(logId) {
                        check(!deleteAttempted) { "The purge deletion closure may be called only once." }
                        deleteAttempted = true
                        context.ensureActive()
                        secureDeleteManagedLog(request.workspaceRoot, path, logId).also { deleteResult = it }
                    }
                    when (outcome) {
                        PurgeDeletionOutcome.DELETED -> {
                            check(deleteResult == true) { "A deleted purge outcome requires one successful deletion." }
                            deleted += 1
                        }
                        PurgeDeletionOutcome.PROTECTED -> {
                            check(!deleteAttempted) { "A protected purge outcome must not execute deletion." }
                            retained += 1
                        }
                        PurgeDeletionOutcome.MISSING ->
                            check(deleteResult == false) { "A missing purge outcome requires one attempted deletion." }
                    }
                }
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                failed += 1
            }
        }
        return PurgeLocalLogsResult(deleted, retained, failed)
    }

    override suspend fun updateSyncState(request: SyncStateUpdateRequest) {
        requireAbsoluteWorkspace(request.workspaceRoot)
        if (request.username.isBlank()) {
            throw ApexLogViewerRuntimeException("org-resolution", "A target org is required for sync state.")
        }
        currentCoroutineContext().ensureActive()
        val stateFile = request.workspaceRoot.resolve("apexlogs").resolve(".alv").resolve("sync-state.json")
        val versionFile = stateFile.resolveSibling("version.json")
        try {
            ensureLifecycleVersionMarker(request.workspaceRoot, versionFile)
            val stateLock = acquireSyncStateLock(
                request.workspaceRoot,
                stateFile,
                syncStateLockWaitTimeout,
            )
            try {
                synchronized(localWriteLock(stateFile)) {
                    ensureSafeWorkspacePath(request.workspaceRoot, stateFile)
                    val root = if (Files.isRegularFile(stateFile, LinkOption.NOFOLLOW_LINKS)) {
                        JsonParser.parseString(Files.readString(stateFile, StandardCharsets.UTF_8)).asJsonObject
                    } else {
                        JsonObject()
                    }
                    if (!root.has("version")) root.addProperty("version", 1)
                    val orgs = root.getAsJsonObject("orgs") ?: JsonObject().also { root.add("orgs", it) }
                    val previous = orgs.getAsJsonObject(request.username)
                    val entry = previous?.deepCopy() ?: JsonObject()
                    entry.addProperty("lastSyncStartedAt", request.startedAt)
                    entry.addProperty("lastSyncCompletedAt", request.completedAt)
                    val newestLog = request.newestLog
                    if (
                        request.failedCount == 0 &&
                        newestLog != null &&
                        isNewerCheckpoint(
                            newestLog,
                            previous?.string("lastSyncedStartTime"),
                            previous?.string("lastSyncedLogId"),
                        )
                    ) {
                        entry.addProperty("lastSyncedLogId", newestLog.id)
                        entry.addProperty("lastSyncedStartTime", requireNotNull(newestLog.startTime))
                    }
                    entry.addProperty("existingCount", request.existingCount.coerceAtLeast(0))
                    entry.addProperty("materializedCount", request.materializedCount.coerceAtLeast(0))
                    entry.addProperty("downloadedCount", request.downloadedCount.coerceAtLeast(0))
                    entry.addProperty("failedCount", request.failedCount.coerceAtLeast(0))
                    orgs.add(request.username, entry)
                    writeFileAtomic(request.workspaceRoot, stateFile, root.toString())
                }
            } finally {
                stateLock.close()
            }
        } catch (error: kotlinx.coroutines.CancellationException) {
            throw error
        } catch (error: ApexLogViewerRuntimeException) {
            throw error
        } catch (error: Exception) {
            throw ApexLogViewerRuntimeException(
                "local-persistence",
                "Apex log sync state could not be persisted locally.",
                error,
            )
        }
    }

    private suspend fun resolveConnection(workspaceRoot: Path, targetOrg: String): RuntimeConnection {
        val processResponse = try {
            dependencies.process.execute(
                ProcessRequest(
                    executable = "sf",
                    arguments = listOf("org", "display", "--target-org", targetOrg, "--json"),
                    cwd = workspaceRoot,
                    environment = SALESFORCE_CLI_ENVIRONMENT,
                ),
            )
        } catch (error: CancellationException) {
            throw error
        } catch (error: ApexLogViewerRuntimeException) {
            throw error
        } catch (error: Exception) {
            throw ApexLogViewerRuntimeException("org-resolution", "Salesforce org resolution failed.", error)
        }
        if (processResponse.exitCode != 0) {
            throw ApexLogViewerRuntimeException("org-resolution", "Salesforce org resolution failed.")
        }
        return try {
            val envelope = parseSalesforceCliJsonObject(processResponse.stdout)
            val result = envelope.getAsJsonObject("result")
            require(envelope.get("status")?.asInt == 0 && result != null)
            val displayedAccessToken = result.string("accessToken")
            RuntimeConnection(
                username = requireNotNull(result.string("username")).trim().also { require(it.isNotEmpty()) },
                alias = result.string("alias")?.trim()?.takeIf(String::isNotEmpty),
                instanceUrl = canonicalHttpsInstanceUrl(requireNotNull(result.string("instanceUrl"))),
                accessToken = displayedAccessToken.usableSalesforceAccessToken()
                    ?: resolveAccessToken(workspaceRoot, targetOrg),
                apiVersion = validatedApiVersion(result.string("apiVersion") ?: DEFAULT_API_VERSION),
            )
        } catch (error: CancellationException) {
            throw error
        } catch (error: ApexLogViewerRuntimeException) {
            throw error
        } catch (error: Exception) {
            throw ApexLogViewerRuntimeException("org-resolution", "Salesforce org resolution returned invalid data.", error)
        }
    }

    private suspend fun resolveAccessToken(workspaceRoot: Path, targetOrg: String): String {
        val processResponse = try {
            dependencies.process.execute(
                ProcessRequest(
                    executable = "sf",
                    arguments = listOf("org", "auth", "show-access-token", "--target-org", targetOrg, "--json"),
                    cwd = workspaceRoot,
                    environment = SALESFORCE_CLI_ENVIRONMENT,
                ),
            )
        } catch (error: CancellationException) {
            throw error
        } catch (error: ApexLogViewerRuntimeException) {
            throw error
        } catch (error: Exception) {
            throw ApexLogViewerRuntimeException("org-resolution", "Salesforce access token resolution failed.", error)
        }
        if (processResponse.exitCode != 0) {
            throw ApexLogViewerRuntimeException("org-resolution", "Salesforce access token resolution failed.")
        }
        return try {
            val envelope = parseSalesforceCliJsonObject(processResponse.stdout)
            val result = envelope.getAsJsonObject("result")
            require(envelope.get("status")?.asInt == 0 && result != null)
            requireNotNull(result.string("accessToken").usableSalesforceAccessToken())
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            throw ApexLogViewerRuntimeException(
                "org-resolution",
                "Salesforce access token resolution returned invalid data.",
                error,
            )
        }
    }

    private suspend fun executeAuthenticatedHttp(
        workspaceRoot: Path,
        targetOrg: String,
        failureMessage: String,
        initialConnection: RuntimeConnection? = null,
        request: (RuntimeConnection) -> HttpRequest,
    ): AuthenticatedHttp {
        suspend fun execute(connection: RuntimeConnection): HttpResponse = try {
            dependencies.http.execute(request(connection))
        } catch (error: CancellationException) {
            throw error
        } catch (error: ApexLogViewerRuntimeException) {
            throw error
        } catch (error: Exception) {
            throw ApexLogViewerRuntimeException("remote-acquisition", failureMessage, error)
        }

        var connection = initialConnection ?: resolveConnection(workspaceRoot, targetOrg)
        var response = execute(connection)
        if (response.status == 401) {
            connection = resolveConnection(workspaceRoot, targetOrg)
            response = execute(connection)
        }
        return AuthenticatedHttp(connection, response)
    }

    override fun close() = Unit

    private suspend fun readLogTextCancellable(path: Path): String {
        val context = currentCoroutineContext()
        val text = StringBuilder()
        Files.newBufferedReader(path, StandardCharsets.UTF_8).use { reader ->
            val buffer = CharArray(LOG_READ_BUFFER_SIZE)
            while (true) {
                context.ensureActive()
                val count = reader.read(buffer)
                if (count < 0) break
                text.append(buffer, 0, count)
            }
        }
        context.ensureActive()
        return text.toString()
    }

    private fun requireAbsoluteWorkspace(workspaceRoot: Path) {
        if (!workspaceRoot.isAbsolute) {
            throw ApexLogViewerRuntimeException(
                code = "local-persistence",
                message = "Apex log workspace root must be an absolute path.",
            )
        }
    }

    private fun readSyncState(workspaceRoot: Path, apexlogsRoot: Path): Map<String, JsonObject> {
        val stateFile = apexlogsRoot.resolve(".alv").resolve("sync-state.json")
        return try {
            ensureSafeWorkspacePath(workspaceRoot, stateFile)
            if (!Files.exists(stateFile, LinkOption.NOFOLLOW_LINKS)) return emptyMap()
            val parsed = JsonParser.parseString(Files.readString(stateFile)).asJsonObject
            parsed.getAsJsonObject("orgs")?.entrySet()?.associate { (username, value) ->
                username to value.asJsonObject
            }.orEmpty()
        } catch (error: ApexLogViewerRuntimeException) {
            throw error
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
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) return null
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

private fun parseLogLine(raw: String, index: Int): ParsedLogEntry? {
    val line = raw.trimEnd()
    if (line.isEmpty()) return null
    if ('|' !in line) {
        return ParsedLogEntry(index, "", type = "INFO", message = line, raw = raw, category = LogCategory.OTHER)
    }

    val parts = line.split('|')
    val prefix = parts.firstOrNull().orEmpty()
    val timestampMatch = LOG_TIMESTAMP.find(prefix)
    val timestamp = timestampMatch?.groupValues?.get(1).orEmpty().ifEmpty { prefix.trim() }
    val elapsed = timestampMatch?.groupValues?.get(2)?.takeIf(String::isNotEmpty)
    val type = parts.getOrNull(1)?.trim().orEmpty().ifEmpty { "UNKNOWN" }
    val category = categorizeLogType(type)
    var tokens = parts.drop(2).map(String::trim).filter(String::isNotEmpty)
    val lineNumber = tokens.firstOrNull()?.let { token ->
        LOG_LINE_NUMBER.matchEntire(token)?.groupValues?.get(1)?.toIntOrNull()
    }
    if (lineNumber != null) tokens = tokens.drop(1)

    var details: String? = null
    val messageTokens = tokens.toMutableList()
    val candidate = messageTokens.lastOrNull().orEmpty()
    if (messageTokens.size > 1 && when (category) {
            LogCategory.CODE -> true
            LogCategory.SOQL -> SOQL_DETAIL.containsMatchIn(candidate) || candidate.length > 60
            LogCategory.DML -> DML_DETAIL.containsMatchIn(candidate.trim())
            else -> false
        }
    ) {
        details = messageTokens.removeLast()
    }
    var message = messageTokens.joinToString(" | ")
    if (message.isEmpty() && details != null) {
        message = details
        details = null
    }
    return ParsedLogEntry(
        id = index,
        timestamp = timestamp,
        elapsed = elapsed,
        type = type,
        lineNumber = lineNumber,
        message = message,
        details = details,
        raw = raw,
        category = category,
    )
}

private fun categorizeLogType(type: String): LogCategory {
    val upper = type.uppercase()
    if (upper.split(NON_LETTERS).any(ERROR_EVENT_TOKENS::contains)) return LogCategory.ERROR
    return when {
        upper == "USER_DEBUG" -> LogCategory.DEBUG
        upper.startsWith("SOQL") -> LogCategory.SOQL
        upper.startsWith("DML") -> LogCategory.DML
        upper.startsWith("CODE_UNIT") -> LogCategory.CODE
        upper.startsWith("LIMIT_USAGE") -> LogCategory.LIMIT
        "METHOD" in upper || upper.endsWith("ENTRY") || upper.endsWith("EXIT") -> LogCategory.SYSTEM
        else -> LogCategory.OTHER
    }
}

private data class DiagnosticContext(
    val eventType: String?,
    val eventDetail: String,
    val variableValue: String? = null,
)

private data class DiagnosticRule(
    val code: String,
    val severity: String,
    val summary: String,
    val priority: Int,
    val matches: (DiagnosticContext) -> Boolean,
)

private suspend fun summarizeLogText(text: String): LogTriageSummary {
    val coroutineContext = currentCoroutineContext()
    val byCode = linkedMapOf<String, LogDiagnostic>()
    splitLogEntries(text).forEach { entry ->
        coroutineContext.ensureActive()
        val context = diagnosticContext(entry)
        val matching = TRIAGE_RULES.filter { it.matches(context) }.toMutableList()
        val specificError = matching.any { it.code in SPECIFIC_ERROR_CODES }
        if (specificError) matching.removeAll { it.code == "fatal_exception" }
        if (matching.any { it.severity == "error" }) matching.removeAll { it.code == "suspicious_error_payload" }
        matching.forEach { rule ->
            byCode.putIfAbsent(
                rule.code,
                LogDiagnostic(
                    code = rule.code,
                    severity = rule.severity,
                    summary = rule.summary,
                    line = TRIAGE_SOURCE_LINE.find(entry)?.groupValues?.get(1)?.toIntOrNull(),
                    eventType = context.eventType,
                ),
            )
        }
    }
    val priorities = TRIAGE_RULES.associate { it.code to it.priority }
    val reasons = byCode.values.sortedBy { priorities[it.code] ?: Int.MAX_VALUE }
    return LogTriageSummary(
        hasErrors = reasons.any { it.severity == "error" },
        primaryReason = reasons.firstOrNull()?.summary,
        reasons = reasons,
    )
}

private suspend fun splitLogEntries(text: String): List<String> {
    val context = currentCoroutineContext()
    val entries = mutableListOf<String>()
    var current: String? = null
    text.lineSequence().forEach { raw ->
        context.ensureActive()
        val line = raw.trim()
        if (line.isEmpty()) return@forEach
        if (TRIAGE_ENTRY_START.containsMatchIn(line)) {
            current?.let(entries::add)
            current = line
        } else if (current != null) {
            current += "\n$line"
        }
    }
    current?.let(entries::add)
    return entries
}

private fun diagnosticContext(entry: String): DiagnosticContext {
    val parts = entry.split('|')
    val eventType = parts.getOrNull(1)?.trim()?.takeIf(String::isNotEmpty)
    val afterType = parts.drop(2).toMutableList()
    if (afterType.firstOrNull()?.trim()?.matches(TRIAGE_LINE_TOKEN) == true) afterType.removeFirst()
    val detail = afterType.joinToString("|")
    val variableValue = if (eventType == "VARIABLE_ASSIGNMENT" && afterType.size >= 2) {
        afterType.drop(1).joinToString("|").replace(TRAILING_HEAP_REFERENCE, "")
    } else {
        null
    }
    return DiagnosticContext(eventType, detail, variableValue)
}

private fun normalizeVariableValue(value: String?): String {
    val normalized = value.orEmpty().trim()
    return if (normalized.length >= 2 && normalized.startsWith('"') && normalized.endsWith('"')) {
        normalized.substring(1, normalized.lastIndex).trim()
    } else {
        normalized
    }
}

private fun serializedStatusCode(value: String): String? =
    SERIALIZED_STATUS_CODE.find(value)?.groupValues?.get(1)?.uppercase()

private fun serializedMessage(value: String): String? =
    SERIALIZED_MESSAGE.find(value)?.groupValues?.get(1)?.trim()

private fun looksLikeSerializedErrorPayload(value: String?): Boolean {
    val normalized = normalizeVariableValue(value)
    val statusCode = serializedStatusCode(normalized)
    val message = serializedMessage(normalized).orEmpty()
    val messageSignalsError = message.isNotEmpty() &&
        !BENIGN_ERROR_NEGATION.containsMatchIn(message) && ERROR_WORD.containsMatchIn(message)
    return normalized.startsWith("Error [", ignoreCase = true) ||
        (statusCode != null && !BENIGN_STATUS_CODE.matches(statusCode)) || messageSignalsError
}

private fun looksLikeExceptionPayload(value: String?): Boolean =
    EXCEPTION_PAYLOAD.matches(normalizeVariableValue(value))

private fun supportsFailureDiagnostic(type: String?): Boolean =
    type == "VARIABLE_ASSIGNMENT" || type == "EXCEPTION_THROWN" || type == "FATAL_ERROR"

private fun diagnosticCandidate(context: DiagnosticContext): String =
    if (context.eventType == "VARIABLE_ASSIGNMENT") context.variableValue.orEmpty() else context.eventDetail

private val TRIAGE_RULES = listOf(
    DiagnosticRule("assertion_failure", "error", "Assertion failure", 0) { context ->
        supportsFailureDiagnostic(context.eventType) && STRUCTURED_ASSERTION.containsMatchIn(normalizeVariableValue(diagnosticCandidate(context)))
    },
    DiagnosticRule("validation_failure", "error", "Validation failure", 1) { context ->
        if (!supportsFailureDiagnostic(context.eventType)) false else {
            val candidate = normalizeVariableValue(diagnosticCandidate(context))
            when (context.eventType) {
                "VARIABLE_ASSIGNMENT" ->
                    (looksLikeSerializedErrorPayload(candidate) || PLAIN_VALIDATION.containsMatchIn(candidate)) &&
                        VALIDATION_STATUS.containsMatchIn(candidate)
                else -> THROWN_VALIDATION.containsMatchIn(candidate)
            }
        }
    },
    DiagnosticRule("dml_failure", "error", "DML failure", 2) { context ->
        if (!supportsFailureDiagnostic(context.eventType)) false else {
            val candidate = normalizeVariableValue(diagnosticCandidate(context))
            val hasDmlFailure = DML_FAILURE.containsMatchIn(candidate) || DML_STATUS.containsMatchIn(candidate) ||
                (candidate.contains("Database.Error") && serializedStatusCode(candidate)?.let {
                    !BENIGN_STATUS_CODE.matches(it) && !VALIDATION_STATUS.matches(it)
                } == true)
            when (context.eventType) {
                "VARIABLE_ASSIGNMENT" -> hasDmlFailure &&
                    (looksLikeSerializedErrorPayload(candidate) || PLAIN_DML.containsMatchIn(candidate) || DML_STATUS_PREFIX.containsMatchIn(candidate))
                else -> hasDmlFailure && THROWN_DML.containsMatchIn(candidate)
            }
        }
    },
    DiagnosticRule("fatal_exception", "error", "Fatal exception", 3) { context ->
        context.eventType == "FATAL_ERROR" || context.eventType == "EXCEPTION_THROWN" ||
            (context.eventType == "VARIABLE_ASSIGNMENT" && looksLikeExceptionPayload(context.variableValue))
    },
    DiagnosticRule("suspicious_error_payload", "warning", "Suspicious error payload", 4) { context ->
        context.eventType == "VARIABLE_ASSIGNMENT" && looksLikeSerializedErrorPayload(context.variableValue)
    },
    DiagnosticRule("rollback_detected", "warning", "Rollback detected", 5) { it.eventType == "ROLLBACK" },
)

private data class OrgMetadata(val username: String, val alias: String?)

private data class RuntimeConnection(
    val username: String = "",
    val alias: String? = null,
    val instanceUrl: String,
    val accessToken: String,
    val apiVersion: String,
)

private data class AuthenticatedHttp(
    val connection: RuntimeConnection,
    val response: HttpResponse,
)

private val LOG_DAY = Regex("^(unknown-date|\\d{4}-\\d{2}-\\d{2})$")
private val CANONICAL_LOG = Regex("^(07L[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?)\\.log$")
private val LEGACY_LOG = Regex("_(07L[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?)\\.log$")
private val APEX_LOG_ID = Regex("^07L[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$")
private val LOG_DAY_DATE = Regex("^\\d{4}-\\d{2}-\\d{2}$")
private val SOQL_DATETIME = Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})$")
private val APEX_EVENT_LINE = Regex("^\\d{1,2}:\\d{2}:\\d{2}\\.\\d+(?:\\s+\\(\\d+\\))?\\s*\\|")
private const val WINDOWS_FILE_ATTRIBUTE_TAG_INFO = 9
private const val WINDOWS_FILE_DISPOSITION_INFO = 4
private const val WINDOWS_FILE_ATTRIBUTE_TAG_INFO_SIZE = 8
private const val WINDOWS_FILE_DISPOSITION_INFO_SIZE = 4
private const val WINDOWS_ERROR_FILE_NOT_FOUND = 2
private const val WINDOWS_ERROR_PATH_NOT_FOUND = 3
private val LOG_TIMESTAMP = Regex("^(\\d{1,2}:\\d{2}:\\d{2}\\.\\d+)(?:\\s+\\((\\d+)\\))?")
private val LOG_LINE_NUMBER = Regex("^\\[(\\d+)]$")
private val SOQL_DETAIL = Regex("\\b(?:select|find)\\b", RegexOption.IGNORE_CASE)
private val DML_DETAIL = Regex("^(?:insert|update|delete|merge|upsert)", RegexOption.IGNORE_CASE)
private val NON_LETTERS = Regex("[^A-Z]+")
private val ERROR_EVENT_TOKENS = setOf("EXCEPTION", "ERROR", "FATAL", "FAIL", "FAILED", "FAILURE", "FAULT")
private val TRIAGE_ENTRY_START = Regex("^\\d{2}:\\d{2}:\\d{2}\\.\\d+(?:\\s+\\([^)]+\\))?\\s*\\|[^|]+(?:\\||$)")
private val TRIAGE_SOURCE_LINE = Regex("\\|\\[(\\d+)]\\|")
private val TRIAGE_LINE_TOKEN = Regex("^\\[[^]]+]$")
private val TRAILING_HEAP_REFERENCE = Regex("\\|0x[0-9a-fA-F]+$")
private val SERIALIZED_STATUS_CODE = Regex("\\b(?:get)?statusCode=([A-Z][A-Z0-9_]+)\\b", RegexOption.IGNORE_CASE)
private val SERIALIZED_MESSAGE = Regex("\\bmessage=([\\s\\S]*?)(?:,\\s*[A-Za-z_]+=|])(?:\\s*$)?", RegexOption.IGNORE_CASE)
private val BENIGN_STATUS_CODE = Regex("^(?:SUCCESS|OK|DONE|NO_ERROR|NONE)$")
private val BENIGN_ERROR_NEGATION = Regex("\\b(?:no|without)\\s+(?:error|errors|exception|exceptions|failure|failures)\\b", RegexOption.IGNORE_CASE)
private val ERROR_WORD = Regex("\\b(?:exception|failed|error)\\b", RegexOption.IGNORE_CASE)
private val EXCEPTION_PAYLOAD = Regex("^[A-Za-z0-9_$.]+Exception(?::\\s+\\S.*)?$")
private val STRUCTURED_ASSERTION = Regex("^(?:[A-Za-z0-9_$.]+\\.)?AssertException(?::|\\b)|^Assertion Failed(?=[:.]|$)", RegexOption.IGNORE_CASE)
private val VALIDATION_STATUS = Regex("FIELD_CUSTOM_VALIDATION_EXCEPTION|VALIDATION_EXCEPTION", RegexOption.IGNORE_CASE)
private val PLAIN_VALIDATION = Regex("^(?:FIELD_CUSTOM_VALIDATION_EXCEPTION|VALIDATION_EXCEPTION)(?:$|[,:])", RegexOption.IGNORE_CASE)
private val THROWN_VALIDATION = Regex("DmlException.*(?:FIELD_CUSTOM_VALIDATION_EXCEPTION|VALIDATION_EXCEPTION)|(?:statusCode=|first error:\\s*)(?:FIELD_CUSTOM_VALIDATION_EXCEPTION|VALIDATION_EXCEPTION)", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
private val DML_STATUS = Regex("REQUIRED_FIELD_MISSING|FIELD_INTEGRITY_EXCEPTION|DUPLICATE_VALUE|INVALID_FIELD_FOR_INSERT_UPDATE|STRING_TOO_LONG|INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST|INVALID_CROSS_REFERENCE_KEY|CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY|DELETE_FAILED|ENTITY_IS_DELETED")
private val DML_FAILURE = Regex("DmlException|Insert failed|Update failed|Upsert failed|Delete failed|Merge failed", RegexOption.IGNORE_CASE)
private val PLAIN_DML = Regex("\\b(?:Insert|Update|Upsert|Delete|Merge) failed\\. First exception on row\\b", RegexOption.IGNORE_CASE)
private val DML_STATUS_PREFIX = Regex("^(?:${DML_STATUS.pattern})(?=[,:]|$)")
private val THROWN_DML = Regex("DmlException|(?:statusCode=|first error:\\s*)(?:${DML_STATUS.pattern})", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
private val SPECIFIC_ERROR_CODES = setOf("assertion_failure", "validation_failure", "dml_failure")
private val LOCAL_WRITE_LOCKS = Array(64) { Any() }

private fun localWriteLock(path: Path): Any {
    val hash = path.toAbsolutePath().normalize().toString().hashCode()
    return LOCAL_WRITE_LOCKS[Math.floorMod(hash, LOCAL_WRITE_LOCKS.size)]
}

private fun JsonObject.string(key: String): String? =
    get(key)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString

private fun isNewerCheckpoint(log: LogListRow, currentStartTime: String?, currentLogId: String?): Boolean {
    val candidateStartTime = log.startTime?.takeIf(String::isNotBlank) ?: return false
    val currentStart = currentStartTime?.takeIf(String::isNotBlank) ?: return true
    val startComparison = candidateStartTime.compareTo(currentStart)
    return startComparison > 0 || startComparison == 0 && log.id > currentLogId.orEmpty()
}

private fun JsonObject.number(key: String): Int? = try {
    get(key)?.takeUnless(JsonElement::isJsonNull)?.asDouble?.takeIf(Double::isFinite)?.toInt()
} catch (_: Exception) {
    null
}

private fun JsonObject.boolean(key: String): Boolean = try {
    get(key)?.takeUnless(JsonElement::isJsonNull)?.asBoolean ?: false
} catch (_: Exception) {
    false
}

private val ORG_LIST_ARRAY_KEYS = listOf(
    "orgs",
    "nonScratchOrgs",
    "scratchOrgs",
    "sandboxes",
    "devHubs",
    "results",
)

private val rejectingProcess = RuntimeProcess {
    throw ApexLogViewerRuntimeException("UNEXPECTED_EXTERNAL_CALL", "The runtime process boundary is not configured.")
}

private val rejectingHttp = RuntimeHttp {
    throw ApexLogViewerRuntimeException("UNEXPECTED_EXTERNAL_CALL", "The runtime HTTP boundary is not configured.")
}

fun createApexLogViewerRuntime(): ApexLogViewerRuntime =
    createApexLogViewerRuntime(RuntimeDependencies(rejectingProcess, rejectingHttp))

fun createApexLogViewerRuntime(dependencies: RuntimeDependencies): ApexLogViewerRuntime =
    DefaultApexLogViewerRuntime(dependencies, SYNC_STATE_LOCK_WAIT_TIMEOUT)

internal fun createApexLogViewerRuntime(
    dependencies: RuntimeDependencies,
    syncStateLockWaitTimeout: Duration,
): ApexLogViewerRuntime = DefaultApexLogViewerRuntime(dependencies, syncStateLockWaitTimeout)

private fun safeTargetOrg(value: String): String =
    value.replace(Regex("[^a-zA-Z0-9_.@-]+"), "_").ifEmpty { "default" }

private fun safeStorageOrg(value: String): String =
    safeTargetOrg(value).takeUnless { it == "." || it == ".." } ?: "default"

private fun ensureWorkspaceLogIgnore(workspaceRoot: Path) {
    val gitignore = workspaceRoot.resolve(".gitignore")
    ensureSafeWorkspacePath(workspaceRoot, gitignore)
    val existing = if (Files.exists(gitignore, LinkOption.NOFOLLOW_LINKS)) Files.readString(gitignore) else ""
    val lines = existing.lineSequence().map(String::trim).toSet()
    if ("apexlogs/" in lines || "apexlogs" in lines) return
    val next = when {
        existing.isEmpty() -> "apexlogs/\n"
        existing.endsWith("\n") -> "${existing}apexlogs/\n"
        else -> "${existing}\napexlogs/\n"
    }
    writeFileAtomic(workspaceRoot, gitignore, next)
}

private fun writeOrgMetadata(workspaceRoot: Path, connection: RuntimeConnection) {
    val metadataPath = workspaceRoot.resolve("apexlogs")
        .resolve("orgs")
        .resolve(safeStorageOrg(connection.username))
        .resolve("org.json")
    val metadata = JsonObject().apply {
        addProperty("version", 1)
        addProperty("username", connection.username)
        addProperty("targetOrg", connection.alias ?: connection.username)
        addProperty("safeTargetOrg", safeStorageOrg(connection.username))
        addProperty("resolvedUsername", connection.username)
        connection.alias?.let { addProperty("alias", it) }
        addProperty("instanceUrl", connection.instanceUrl)
        addProperty("updatedAt", Instant.now().toString())
    }
    writeFileAtomic(workspaceRoot, metadataPath, "$metadata\n")
}

private fun writeFileAtomicIfAbsent(workspaceRoot: Path, path: Path, content: String): Boolean {
    return synchronized(localWriteLock(path)) {
            ensureSafeWorkspacePath(workspaceRoot, path)
            if (validateRegularFileIfPresent(path)) return@synchronized false
            createSafeDirectories(workspaceRoot, path.parent)
            val temporary = Files.createTempFile(path.parent, ".${path.fileName}.", ".tmp")
            try {
                Files.writeString(temporary, content, StandardCharsets.UTF_8)
                publishCompletedFileIfAbsent(path, temporary)
            } finally {
                Files.deleteIfExists(temporary)
            }
    }
}

internal fun publishCompletedFileIfAbsent(path: Path, completedTemporary: Path): Boolean = try {
    Files.createLink(path, completedTemporary)
    true
} catch (_: FileAlreadyExistsException) {
    if (validateRegularFileIfPresent(path)) false else throw NoSuchFileException(path.toString())
}

private fun validateRegularFileIfPresent(path: Path): Boolean {
    val attributes = try {
        Files.readAttributes(path, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
    } catch (_: NoSuchFileException) {
        return false
    }
    if (!attributes.isRegularFile || attributes.isSymbolicLink) {
        throw ApexLogViewerRuntimeException("local-persistence", "The Apex log path must be a regular file.")
    }
    return true
}

private fun ensureLifecycleVersionMarker(workspaceRoot: Path, versionFile: Path) {
    ensureSafeWorkspacePath(workspaceRoot, versionFile)
    createSafeDirectories(workspaceRoot, versionFile.parent)
    while (true) {
        if (writeFileAtomicIfAbsent(workspaceRoot, versionFile, "1\n")) return
        ensureSafeWorkspacePath(workspaceRoot, versionFile)
        if (!validateRegularFileIfPresent(versionFile)) continue
        val raw = try {
            Files.newInputStream(
                versionFile,
                StandardOpenOption.READ,
                LinkOption.NOFOLLOW_LINKS,
            ).bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
        } catch (_: NoSuchFileException) {
            continue
        }
        val version = try {
            JsonParser.parseString(raw)
        } catch (error: Exception) {
            throw ApexLogViewerRuntimeException(
                "local-persistence",
                "The shared Apex log lifecycle version marker is not valid JSON.",
                error,
            )
        }
        val supported = version.isJsonPrimitive && version.asJsonPrimitive.isNumber &&
            runCatching { version.asBigDecimal.compareTo(BigDecimal.ONE) == 0 }.getOrDefault(false)
        if (!supported) {
            throw ApexLogViewerRuntimeException(
                "local-persistence",
                "The shared Apex log lifecycle version is not supported.",
            )
        }
        return
    }
}

private fun writeFileAtomic(workspaceRoot: Path, path: Path, content: String) {
    synchronized(localWriteLock(path)) {
            ensureSafeWorkspacePath(workspaceRoot, path)
            createSafeDirectories(workspaceRoot, path.parent)
            val temporary = Files.createTempFile(path.parent, ".${path.fileName}.", ".tmp")
            try {
                Files.writeString(temporary, content, StandardCharsets.UTF_8)
                try {
                    Files.move(
                        temporary,
                        path,
                        StandardCopyOption.ATOMIC_MOVE,
                        StandardCopyOption.REPLACE_EXISTING,
                    )
                } catch (_: AtomicMoveNotSupportedException) {
                    Files.move(temporary, path, StandardCopyOption.REPLACE_EXISTING)
                }
            } finally {
                Files.deleteIfExists(temporary)
            }
    }
}

private suspend fun acquireSyncStateLock(
    workspaceRoot: Path,
    stateFile: Path,
    waitTimeout: Duration,
): SyncStateLock {
    val lockPath = stateFile.resolveSibling("sync-state.lock")
    ensureSafeWorkspacePath(workspaceRoot, lockPath)
    createSafeDirectories(workspaceRoot, lockPath.parent)
    val token = UUID.randomUUID().toString()
    val payload = syncStateLockPayload(ProcessHandle.current().pid(), token)
    val waitStartedAt = System.nanoTime()
    while (true) {
        currentCoroutineContext().ensureActive()
        ensureSafeWorkspacePath(workspaceRoot, lockPath)
        try {
            Files.writeString(
                lockPath,
                payload,
                StandardCharsets.UTF_8,
                StandardOpenOption.CREATE_NEW,
                StandardOpenOption.WRITE,
            )
            return SyncStateLock(lockPath, payload)
        } catch (_: FileAlreadyExistsException) {
            val attributes = try {
                Files.readAttributes(lockPath, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
            } catch (_: NoSuchFileException) {
                continue
            }
            if (!attributes.isRegularFile || Files.isSymbolicLink(lockPath)) {
                throw ApexLogViewerRuntimeException(
                    "local-persistence",
                    "The shared Apex log sync-state lock is not a regular file.",
                )
            }
            if (reclaimStaleSyncStateLock(lockPath)) continue
            if (Duration.ofNanos(System.nanoTime() - waitStartedAt) >= waitTimeout) {
                throw ApexLogViewerRuntimeException(
                    "local-persistence",
                    "Timed out waiting for the shared Apex log sync-state lock.",
                )
            }
            delay(SYNC_STATE_LOCK_RETRY_MS)
        }
    }
}

private fun reclaimStaleSyncStateLock(lockPath: Path): Boolean {
    val attributes = try {
        Files.readAttributes(lockPath, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
    } catch (_: NoSuchFileException) {
        return true
    }
    if (!attributes.isRegularFile || Files.isSymbolicLink(lockPath)) {
        throw ApexLogViewerRuntimeException(
            "local-persistence",
            "The shared Apex log sync-state lock changed to a non-regular file during stale inspection.",
        )
    }
    val staleBefore = Instant.now().minus(SYNC_STATE_LOCK_STALE_AFTER)
    if (attributes.lastModifiedTime().toInstant().isAfter(staleBefore)) return false
    val observedPayload = Files.readString(lockPath, StandardCharsets.UTF_8)
    val owner = parseCanonicalSyncStateLockOwner(observedPayload) ?: return false
    if (!isProcessProvenDead(owner.pid)) return false
    val reclaimMarker = lockPath.resolveSibling("sync-state.lock.reclaim-${owner.token}")
    try {
        Files.writeString(
            reclaimMarker,
            observedPayload,
            StandardCharsets.UTF_8,
            StandardOpenOption.CREATE_NEW,
            StandardOpenOption.WRITE,
        )
    } catch (_: FileAlreadyExistsException) {
        return false
    }
    val currentAttributes = try {
        Files.readAttributes(lockPath, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
    } catch (_: NoSuchFileException) {
        return true
    }
    if (!currentAttributes.isRegularFile || Files.isSymbolicLink(lockPath)) {
        throw ApexLogViewerRuntimeException(
            "local-persistence",
            "The shared Apex log sync-state lock changed to a non-regular file during stale reclaim.",
        )
    }
    if (Files.readString(lockPath, StandardCharsets.UTF_8) != observedPayload) return false
    Files.deleteIfExists(lockPath)
    return true
}

private data class SyncStateLockOwner(
    val pid: Long,
    val token: String,
)

private fun syncStateLockPayload(pid: Long, token: String): String =
    """{"version":1,"pid":$pid,"token":"$token"}"""

private fun parseCanonicalSyncStateLockOwner(payload: String): SyncStateLockOwner? = runCatching {
    val root = JsonParser.parseString(payload).asJsonObject
    val version = root.get("version")?.asInt
    val pid = root.get("pid")?.asLong ?: return@runCatching null
    val token = UUID.fromString(root.get("token")?.asString).toString()
    if (version != 1 || pid <= 0 || payload != syncStateLockPayload(pid, token)) return@runCatching null
    SyncStateLockOwner(pid, token)
}.getOrNull()

private fun isProcessProvenDead(pid: Long): Boolean = runCatching {
    val process = ProcessHandle.of(pid)
    process.isEmpty || !process.get().isAlive
}.getOrDefault(false)

private class SyncStateLock(
    private val path: Path,
    private val payload: String,
) : AutoCloseable {
    override fun close() {
        val attributes = try {
            Files.readAttributes(path, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
        } catch (_: NoSuchFileException) {
            return
        }
        if (!attributes.isRegularFile || Files.isSymbolicLink(path)) {
            throw ApexLogViewerRuntimeException(
                "local-persistence",
                "The shared Apex log sync-state lock changed to a non-regular file before release.",
            )
        }
        if (Files.readString(path, StandardCharsets.UTF_8) == payload) Files.delete(path)
    }
}

private fun findLifecycleLogPath(workspaceRoot: Path, username: String, log: LogListRow): Path? {
    val safeUsername = safeStorageOrg(username)
    val logsRoot = workspaceRoot.resolve("apexlogs").resolve("orgs").resolve(safeUsername).resolve("logs")
    ensureSafeWorkspacePath(workspaceRoot, logsRoot)
    val knownDay = log.startTime?.take(10)?.takeIf(LOG_DAY_DATE::matches)
    if (knownDay != null) {
        val candidate = logsRoot.resolve(knownDay).resolve("${log.id}.log")
        ensureSafeWorkspacePath(workspaceRoot, candidate)
        if (Files.isRegularFile(candidate, LinkOption.NOFOLLOW_LINKS)) return candidate
    }
    if (Files.isDirectory(logsRoot, LinkOption.NOFOLLOW_LINKS)) {
        Files.newDirectoryStream(logsRoot).use { days ->
            for (day in days) {
                if (!Files.isDirectory(day, LinkOption.NOFOLLOW_LINKS) || !LOG_DAY.matches(day.fileName.toString())) continue
                val candidate = day.resolve("${log.id}.log")
                ensureSafeWorkspacePath(workspaceRoot, candidate)
                if (Files.isRegularFile(candidate, LinkOption.NOFOLLOW_LINKS)) return candidate
            }
        }
    }
    val legacy = workspaceRoot.resolve("apexlogs").resolve("${safeUsername}_${log.id}.log")
    ensureSafeWorkspacePath(workspaceRoot, legacy)
    return legacy.takeIf { Files.isRegularFile(it, LinkOption.NOFOLLOW_LINKS) }
}

private fun createSafeDirectories(workspaceRoot: Path, directory: Path) {
    val root = workspaceRoot.toAbsolutePath().normalize()
    val target = directory.toAbsolutePath().normalize()
    if (!target.startsWith(root)) {
        throw ApexLogViewerRuntimeException("local-persistence", "The Apex log path escapes the workspace.")
    }
    var current = root
    root.relativize(target).forEach { segment ->
        current = current.resolve(segment)
        if (!Files.exists(current, LinkOption.NOFOLLOW_LINKS)) {
            try {
                Files.createDirectory(current)
            } catch (_: FileAlreadyExistsException) {
                // A concurrent materialization created the same lifecycle directory.
            }
        }
        ensureSafeWorkspacePath(root, current)
        if (!Files.isDirectory(current, LinkOption.NOFOLLOW_LINKS)) {
            throw ApexLogViewerRuntimeException("local-persistence", "The Apex log path is not a directory.")
        }
    }
}

private fun ensureSafeWorkspacePath(workspaceRoot: Path, path: Path) {
    val root = workspaceRoot.toAbsolutePath().normalize()
    val target = path.toAbsolutePath().normalize()
    if (!target.startsWith(root)) {
        throw ApexLogViewerRuntimeException("local-persistence", "The Apex log path escapes the workspace.")
    }
    var current = root
    root.relativize(target).forEach { segment ->
        current = current.resolve(segment)
        if (!Files.exists(current, LinkOption.NOFOLLOW_LINKS)) return@forEach
        val attributes = Files.readAttributes(current, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
        if (Files.isSymbolicLink(current) || attributes.isOther) {
            throw ApexLogViewerRuntimeException("local-persistence", "The Apex log path contains a linked component.")
        }
    }
}

internal fun managedLifecycleLogId(workspaceRoot: Path, path: Path): String? {
    val apexlogsRoot = workspaceRoot.toAbsolutePath().normalize().resolve("apexlogs")
    val normalizedPath = path.toAbsolutePath().normalize()
    if (!normalizedPath.startsWith(apexlogsRoot)) return null
    if (runCatching { ensureSafeWorkspacePath(workspaceRoot, normalizedPath) }.isFailure) return null
    if (!Files.isRegularFile(normalizedPath, LinkOption.NOFOLLOW_LINKS) || Files.isSymbolicLink(normalizedPath)) return null
    val relative = apexlogsRoot.relativize(normalizedPath)
    val name = relative.fileName?.toString().orEmpty()
    if (relative.nameCount == 1) return managedLegacyLogId(name)
    if (
        relative.nameCount == 5 &&
        relative.getName(0).toString() == "orgs" &&
        relative.getName(2).toString() == "logs" &&
        LOG_DAY.matches(relative.getName(3).toString())
    ) {
        return CANONICAL_LOG.matchEntire(name)?.groupValues?.get(1)
    }
    return null
}

internal fun supportsSecurePurgeDeletion(workspaceRoot: Path): Boolean = runCatching {
    isWindowsRuntime() ||
        Files.newDirectoryStream(workspaceRoot.toAbsolutePath().normalize()).use { it is SecureDirectoryStream<*> }
}.getOrDefault(false)

private fun secureDeleteManagedLog(workspaceRoot: Path, candidate: Path, logId: String): Boolean {
    val root = workspaceRoot.toAbsolutePath().normalize()
    val segments = managedPurgePathSegments(root, candidate, logId)
        ?: throw IOException("Apex log retention may delete only a managed log body matching its log ID.")
    if (isWindowsRuntime()) return windowsDeleteManagedLog(root, segments)
    Files.newDirectoryStream(root).use { directory ->
        @Suppress("UNCHECKED_CAST")
        val secureRoot = directory as? SecureDirectoryStream<Path>
            // Windows' default provider does not expose handle-relative deletion. Fail closed and let
            // purgeLocalLogs report this candidate as failed rather than falling back to a pathname delete.
            ?: throw IOException("Secure handle-relative Apex log deletion is unavailable on this filesystem.")
        return secureDeleteManagedLogFrom(secureRoot, segments, 0)
    }
}

private fun windowsDeleteManagedLog(workspaceRoot: Path, segments: List<Path>): Boolean {
    val handles = mutableListOf<WinNT.HANDLE>()
    try {
        var current = workspaceRoot
        val rootHandle = openWindowsPurgeHandle(
            current,
            WinNT.FILE_READ_ATTRIBUTES,
            WinNT.FILE_FLAG_OPEN_REPARSE_POINT or WinNT.FILE_FLAG_BACKUP_SEMANTICS,
        ) ?: return false
        handles += rootHandle
        validateWindowsPurgeHandle(rootHandle, expectDirectory = true)
        segments.dropLast(1).forEach { segment ->
            current = current.resolve(segment)
            val directoryHandle = openWindowsPurgeHandle(
                current,
                WinNT.FILE_READ_ATTRIBUTES,
                WinNT.FILE_FLAG_OPEN_REPARSE_POINT or WinNT.FILE_FLAG_BACKUP_SEMANTICS,
            ) ?: return false
            handles += directoryHandle
            validateWindowsPurgeHandle(directoryHandle, expectDirectory = true)
        }
        val fileHandle = openWindowsPurgeHandle(
            current.resolve(segments.last()),
            WinNT.DELETE or WinNT.FILE_READ_ATTRIBUTES,
            WinNT.FILE_FLAG_OPEN_REPARSE_POINT,
        ) ?: return false
        handles += fileHandle
        validateWindowsPurgeHandle(fileHandle, expectDirectory = false)
        val disposition = Memory(WINDOWS_FILE_DISPOSITION_INFO_SIZE.toLong()).apply { setInt(0, 1) }
        if (!Kernel32.INSTANCE.SetFileInformationByHandle(
                fileHandle,
                WINDOWS_FILE_DISPOSITION_INFO,
                disposition,
                com.sun.jna.platform.win32.WinDef.DWORD(WINDOWS_FILE_DISPOSITION_INFO_SIZE.toLong()),
            )
        ) {
            throw windowsPurgeIOException("Could not mark the managed Apex log for deletion")
        }
        return true
    } finally {
        handles.asReversed().forEach(Kernel32.INSTANCE::CloseHandle)
    }
}

private fun openWindowsPurgeHandle(path: Path, desiredAccess: Int, flags: Int): WinNT.HANDLE? {
    val handle = Kernel32.INSTANCE.CreateFile(
        path.toString(),
        desiredAccess,
        WinNT.FILE_SHARE_READ or WinNT.FILE_SHARE_WRITE,
        null,
        WinNT.OPEN_EXISTING,
        flags,
        null,
    )
    if (handle != WinBase.INVALID_HANDLE_VALUE) return handle
    return when (Native.getLastError()) {
        WINDOWS_ERROR_FILE_NOT_FOUND, WINDOWS_ERROR_PATH_NOT_FOUND -> null
        else -> throw windowsPurgeIOException("Could not open the managed Apex log path securely")
    }
}

private fun validateWindowsPurgeHandle(handle: WinNT.HANDLE, expectDirectory: Boolean) {
    val attributes = Memory(WINDOWS_FILE_ATTRIBUTE_TAG_INFO_SIZE.toLong())
    if (!Kernel32.INSTANCE.GetFileInformationByHandleEx(
            handle,
            WINDOWS_FILE_ATTRIBUTE_TAG_INFO,
            attributes,
            com.sun.jna.platform.win32.WinDef.DWORD(WINDOWS_FILE_ATTRIBUTE_TAG_INFO_SIZE.toLong()),
        )
    ) {
        throw windowsPurgeIOException("Could not validate the managed Apex log path")
    }
    val fileAttributes = attributes.getInt(0)
    val isDirectory = fileAttributes and WinNT.FILE_ATTRIBUTE_DIRECTORY != 0
    if (fileAttributes and WinNT.FILE_ATTRIBUTE_REPARSE_POINT != 0 || isDirectory != expectDirectory) {
        throw IOException("The managed Apex log path contains a reparse point or unexpected file type.")
    }
}

private fun windowsPurgeIOException(action: String): IOException =
    IOException("$action (Windows error ${Native.getLastError()}).")

private fun isWindowsRuntime(): Boolean =
    System.getProperty("os.name").startsWith("Windows", ignoreCase = true)

private fun secureDeleteManagedLogFrom(
    directory: SecureDirectoryStream<Path>,
    segments: List<Path>,
    index: Int,
): Boolean {
    val segment = segments[index]
    if (index < segments.lastIndex) {
        val child = try {
            directory.newDirectoryStream(segment, LinkOption.NOFOLLOW_LINKS)
        } catch (_: NoSuchFileException) {
            return false
        }
        child.use { return secureDeleteManagedLogFrom(it, segments, index + 1) }
    }
    val attributes = try {
        directory.getFileAttributeView(
            segment,
            BasicFileAttributeView::class.java,
            LinkOption.NOFOLLOW_LINKS,
        )?.readAttributes() ?: throw IOException("Apex log attributes are unavailable for secure deletion.")
    } catch (_: NoSuchFileException) {
        return false
    }
    if (!attributes.isRegularFile || attributes.isSymbolicLink) {
        throw IOException("Apex log retention target must remain a regular file.")
    }
    return try {
        directory.deleteFile(segment)
        true
    } catch (_: NoSuchFileException) {
        false
    }
}

private fun managedPurgePathSegments(workspaceRoot: Path, candidate: Path, logId: String): List<Path>? {
    if (!APEX_LOG_ID.matches(logId)) return null
    val root = workspaceRoot.toAbsolutePath().normalize()
    val target = candidate.toAbsolutePath().normalize()
    if (!target.startsWith(root)) return null
    val relative = root.relativize(target)
    if (relative.nameCount < 2 || relative.getName(0).toString() != "apexlogs") return null
    val filename = relative.fileName.toString()
    val filenameLogId = when {
        relative.nameCount == 2 -> managedLegacyLogId(filename)
        relative.nameCount == 6 &&
            relative.getName(1).toString() == "orgs" &&
            relative.getName(3).toString() == "logs" &&
            LOG_DAY.matches(relative.getName(4).toString()) ->
            CANONICAL_LOG.matchEntire(filename)?.groupValues?.get(1)
        else -> null
    }
    if (filenameLogId != logId) return null
    return (0 until relative.nameCount).map(relative::getName)
}

private fun managedLegacyLogId(filename: String): String? {
    val suffix = LEGACY_LOG.find(filename) ?: return null
    val safeUser = filename.substring(0, suffix.range.first)
    if (safeUser.isEmpty() || safeStorageOrg(safeUser) != safeUser) return null
    return suffix.groupValues[1]
}

internal fun hasBoundedApexLogMarker(path: Path): Boolean = runCatching {
    if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) || Files.isSymbolicLink(path)) return@runCatching false
    val prefix = Files.newInputStream(path).use { stream -> stream.readNBytes(APEX_LOG_RECOGNITION_BYTE_LIMIT) }
        .toString(StandardCharsets.UTF_8)
    prefix.lineSequence().take(APEX_LOG_RECOGNITION_LINE_LIMIT).any { line ->
        "APEX_CODE," in line || "|EXECUTION_STARTED|" in line
    }
}.getOrDefault(false)

internal fun parseSalesforceCliJsonObject(output: String): JsonObject {
    val normalizedOutput = SALESFORCE_ANSI_CSI.replace(output, "")
    val candidates = buildList {
        add(normalizedOutput.trim().removePrefix("\uFEFF").trimStart())
        SALESFORCE_JSON_OBJECT_LINE.findAll(normalizedOutput).forEach { match ->
            val objectStart = match.range.first + match.value.indexOf('{')
            add(normalizedOutput.substring(objectStart).trim())
        }
    }.distinct()
    var lastFailure: Exception? = null
    candidates.forEach { candidate ->
        try {
            return JsonParser.parseString(candidate).asJsonObject
        } catch (error: Exception) {
            lastFailure = error
        }
    }
    throw IllegalArgumentException("Salesforce CLI output did not contain a complete JSON object.", lastFailure)
}

private fun String?.usableSalesforceAccessToken(): String? {
    val candidate = this?.trim().orEmpty()
    return candidate.takeIf {
        candidate.isNotEmpty() &&
        candidate.none(Char::isWhitespace) &&
        !SALESFORCE_REDACTED_TOKEN.containsMatchIn(candidate) &&
        !SALESFORCE_TOKEN_INSTRUCTION.containsMatchIn(candidate)
    }
}

private fun canonicalHttpsInstanceUrl(value: String): String {
    val candidate = value.trim()
    val uri = URI(candidate)
    require(uri.isAbsolute && !uri.isOpaque)
    require(uri.scheme.equals("https", ignoreCase = true))
    require(!uri.host.isNullOrBlank())
    require(uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null)
    require(uri.rawPath.isNullOrEmpty() || uri.rawPath == "/")
    return URI("https", null, uri.host.lowercase(Locale.ROOT), uri.port, null, null, null).toASCIIString()
}

private fun validatedApiVersion(value: String): String {
    val candidate = value.trim()
    require(SALESFORCE_API_VERSION.matches(candidate))
    return candidate
}

private fun LogPageSortField.soqlField(): String = when (this) {
    LogPageSortField.START_TIME -> "StartTime"
    LogPageSortField.OPERATION -> "Operation"
    LogPageSortField.STATUS -> "Status"
    LogPageSortField.SIZE -> "LogLength"
    LogPageSortField.LOG_ID -> "Id"
}

private fun LogListRow.sortValue(field: LogPageSortField): String? = when (field) {
    LogPageSortField.START_TIME -> startTime
    LogPageSortField.OPERATION -> operation
    LogPageSortField.STATUS -> status
    LogPageSortField.SIZE -> logLength?.toString()
    LogPageSortField.LOG_ID -> id
}

private fun isValidLogCursor(cursor: LogCursor, request: LogPageRequest): Boolean {
    if (!APEX_LOG_ID.matches(cursor.beforeId)) return false
    if (cursor.sortField != request.sortField || cursor.sortDirection != request.sortDirection) return false
    if (request.requiresSnapshotWatermark() && cursor.snapshotMaxStartTime?.let(SOQL_DATETIME::matches) != true) return false
    if (cursor.snapshotMaxStartTime != null && !SOQL_DATETIME.matches(cursor.snapshotMaxStartTime)) return false
    return when (cursor.sortField) {
        LogPageSortField.START_TIME -> cursor.sortValue?.let(SOQL_DATETIME::matches) == true
        LogPageSortField.SIZE -> cursor.sortValue == null || cursor.sortValue.toIntOrNull() != null
        LogPageSortField.LOG_ID -> cursor.sortValue == cursor.beforeId
        LogPageSortField.OPERATION, LogPageSortField.STATUS ->
            cursor.sortValue == null || cursor.sortValue.length <= MAX_CURSOR_TEXT_LENGTH
    }
}

private fun LogPageRequest.requiresSnapshotWatermark(): Boolean =
    sortField != LogPageSortField.START_TIME || sortDirection != LogPageSortDirection.DESCENDING

private fun keysetWhereClause(cursor: LogCursor): String {
    val comparison = if (cursor.sortDirection == LogPageSortDirection.ASCENDING) ">" else "<"
    val id = "'${cursor.beforeId}'"
    if (cursor.sortField == LogPageSortField.LOG_ID) return "Id $comparison $id"
    val field = cursor.sortField.soqlField()
    val value = cursor.sortValue
    if (value == null) {
        return if (cursor.sortDirection == LogPageSortDirection.ASCENDING) {
            "(($field = null AND Id > $id) OR $field != null)"
        } else {
            "($field = null AND Id < $id)"
        }
    }
    val literal = when (cursor.sortField) {
        LogPageSortField.START_TIME, LogPageSortField.SIZE -> value
        else -> "'${value.replace("'", "\\'")}'"
    }
    val nullTail = if (cursor.sortDirection == LogPageSortDirection.DESCENDING) " OR $field = null" else ""
    return "($field $comparison $literal OR ($field = $literal AND Id $comparison $id)$nullTail)"
}

private const val APEX_LOG_RECOGNITION_LINE_LIMIT = 10
private const val APEX_LOG_RECOGNITION_BYTE_LIMIT = 64 * 1024
private const val LOG_READ_BUFFER_SIZE = 8 * 1024
private const val MAX_CURSOR_TEXT_LENGTH = 1_024
private const val DEFAULT_API_VERSION = "63.0"
private val SALESFORCE_CLI_ENVIRONMENT = mapOf(
    "FORCE_COLOR" to "0",
    "SF_CONTENT_TYPE" to "JSON",
    "SF_HIDE_RELEASE_NOTES" to "true",
)
private val SALESFORCE_ANSI_CSI = Regex("\u001B\\[[0-?]*[ -/]*[@-~]")
private val SALESFORCE_JSON_OBJECT_LINE = Regex("(?m)^[\\t ]*\\{")
private val SALESFORCE_REDACTED_TOKEN = Regex("^\\[?redacted\\]?", RegexOption.IGNORE_CASE)
private val SALESFORCE_TOKEN_INSTRUCTION = Regex("use ['\"]?sf org auth", RegexOption.IGNORE_CASE)
private val SALESFORCE_API_VERSION = Regex("^[1-9][0-9]{0,2}\\.[0-9]{1,2}$")
private const val SYNC_STATE_LOCK_RETRY_MS = 100L
private val SYNC_STATE_LOCK_STALE_AFTER: Duration = Duration.ofSeconds(120)
private val SYNC_STATE_LOCK_WAIT_TIMEOUT: Duration = Duration.ofSeconds(30)
