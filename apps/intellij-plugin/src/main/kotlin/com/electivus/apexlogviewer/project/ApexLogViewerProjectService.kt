package com.electivus.apexlogviewer.project

import com.electivus.apexlogviewer.ApexLogViewerBundle
import com.electivus.apexlogviewer.runtime.ApexLogViewerRuntimeException
import com.electivus.apexlogviewer.runtime.LogListRow
import com.electivus.apexlogviewer.runtime.LogCursor
import com.electivus.apexlogviewer.runtime.LogPageRequest
import com.electivus.apexlogviewer.runtime.LogPageSortDirection
import com.electivus.apexlogviewer.runtime.LogPageSortField
import com.electivus.apexlogviewer.runtime.LogTriageSummary
import com.electivus.apexlogviewer.runtime.LocalLogSearchRequest
import com.electivus.apexlogviewer.runtime.LocalLogFile
import com.electivus.apexlogviewer.runtime.LogSearchMatch
import com.electivus.apexlogviewer.runtime.OrgListItem
import com.electivus.apexlogviewer.runtime.OrgListRequest
import com.electivus.apexlogviewer.runtime.PurgeDeletionGuard
import com.electivus.apexlogviewer.runtime.PurgeDeletionOutcome
import com.electivus.apexlogviewer.runtime.PurgeLocalLogsRequest
import com.electivus.apexlogviewer.runtime.RequireLocalLogRequest
import com.electivus.apexlogviewer.runtime.SyncStateUpdateRequest
import com.electivus.apexlogviewer.runtime.ParseLogRequest
import com.electivus.apexlogviewer.runtime.RuntimeDependencies
import com.electivus.apexlogviewer.runtime.createApexLogViewerRuntime
import com.electivus.apexlogviewer.runtime.defaultRuntimeDependencies
import com.electivus.apexlogviewer.runtime.managedLifecycleLogId
import com.electivus.apexlogviewer.runtime.hasBoundedApexLogMarker
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.project.Project
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.platform.ide.progress.withBackgroundProgress
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

data class ProjectFailure(
    val code: String,
    val message: String,
)

enum class LogSortField {
    START_TIME,
    OPERATION,
    STATUS,
    SIZE,
    LOG_ID,
}

enum class LogSortDirection {
    ASCENDING,
    DESCENDING,
}

data class LogViewOptions(
    val user: String? = null,
    val operation: String? = null,
    val status: String? = null,
    val errorsOnly: Boolean = false,
    val sortField: LogSortField = LogSortField.START_TIME,
    val sortDirection: LogSortDirection = LogSortDirection.DESCENDING,
)

data class LogsProjectState(
    val orgs: List<OrgListItem> = emptyList(),
    val selectedOrg: String? = null,
    val logs: List<LogListRow> = emptyList(),
    val isRefreshing: Boolean = false,
    val isLoadingMore: Boolean = false,
    val hasMoreLogs: Boolean = false,
    val isDownloadingAll: Boolean = false,
    val downloadProcessed: Int = 0,
    val downloadFailureCount: Int = 0,
    val isAcquiringBodies: Boolean = false,
    val acquisitionProcessed: Int = 0,
    val acquisitionFailureCount: Int = 0,
    val isMaterializingSelectedLog: Boolean = false,
    val triageByLogId: Map<String, LogTriageSummary> = emptyMap(),
    val availableOperations: List<String> = emptyList(),
    val availableStatuses: List<String> = emptyList(),
    val availableUsers: List<String> = emptyList(),
    val viewOptions: LogViewOptions = LogViewOptions(),
    val failure: ProjectFailure? = null,
    val search: SearchProjectState = SearchProjectState(),
)

data class SearchProjectState(
    val query: String = "",
    val isSearching: Boolean = false,
    val isRemoteSearching: Boolean = false,
    val matches: List<LogSearchMatch> = emptyList(),
    val pendingLogIds: List<String> = emptyList(),
    val failedLogIds: List<String> = emptyList(),
    val pagesExamined: Int = 0,
    val bodiesProcessed: Int = 0,
    val partialFailureCount: Int = 0,
    val matchOffset: Int = 0,
    val totalMatches: Int = 0,
    val snapshotExhausted: Boolean = false,
    val canContinue: Boolean = false,
)

@Service(Service.Level.PROJECT)
class ApexLogViewerProjectService @JvmOverloads internal constructor(
    private val workspaceRoot: Path,
    private val coroutineScope: CoroutineScope,
    dependencies: RuntimeDependencies,
    private val pageSize: Int = 50,
    private val backgroundAcquisition: Boolean = false,
    private val afterCatalogCommitValidation: (Long) -> Unit = {},
    private val afterCatalogCommitRejection: (Long) -> Unit = {},
    private val afterSearchCheckpointValidation: (Long) -> Unit = {},
    private val afterAcquisitionCommitValidation: (Long, String) -> Unit = { _, _ -> },
    private val beforeAcquisitionJobRegistration: (Long, String) -> Unit = { _, _ -> },
    private val beforeOrgSelectionInvalidation: () -> Unit = {},
    private val afterOrgSelectionInvalidation: () -> Unit = {},
    private val beforeTriageSummaryCommit: (String, String) -> Unit = { _, _ -> },
    private val afterTriageSummaryCommit: (String, String) -> Unit = { _, _ -> },
    private val beforeRetentionProtectionCheck: (String) -> Unit = {},
    private val afterRetentionDeletionValidation: (String) -> Unit = {},
    private val afterRetentionPurge: () -> Unit = {},
) : Disposable {
    private var processingConcurrency: Int = 4
    private var intellijProject: Project? = null
    private var applicationSettings: ApexLogViewerApplicationSettings? = null
    private var settings: ApexLogViewerSettings? = null
    private var diagnostics = ApexLogViewerDiagnostics()

    constructor(project: Project, coroutineScope: CoroutineScope) : this(
        workspaceRoot = resolveWorkspaceRoot(project),
        coroutineScope = coroutineScope,
        dependencies = defaultRuntimeDependencies(),
        pageSize = ApplicationManager.getApplication().service<ApexLogViewerApplicationSettings>().pageSize,
        backgroundAcquisition = true,
    ) {
        intellijProject = project
        applicationSettings = ApplicationManager.getApplication().service<ApexLogViewerApplicationSettings>()
        processingConcurrency = applicationSettings?.processingConcurrency ?: processingConcurrency
        settings = project.service<ApexLogViewerSettings>()
        diagnostics = project.service<ApexLogViewerDiagnostics>()
        mutableState.value = LogsProjectState(
            viewOptions = settings?.viewOptions ?: LogViewOptions(),
            search = SearchProjectState(query = settings?.searchQuery.orEmpty()),
        )
        registerOpenLogProtection(project)
    }

    private val runtime = createApexLogViewerRuntime(dependencies)
    private val mutableState = MutableStateFlow(LogsProjectState())
    private var refreshJob: Job? = null
    private var searchJob: Job? = null
    private var loadMoreJob: Job? = null
    private var downloadAllJob: Job? = null
    private var acquisitionJob: Job? = null
    private var purgeJob: Job? = null
    private var acquisitionGeneration: Long = 0
    private var catalogLogs: List<LogListRow> = emptyList()
    private var nextCatalogCursor: LogCursor? = null
    private val catalogCommitLock = Any()
    private var catalogGeneration: Long = 0
    private var retentionGeneration: Long = 0
    private var searchMatchOffset: Int = 0
    private var searchGeneration: Long = 0
    private var searchCheckpoint: ProgressiveSearchCheckpoint? = null
    private val openLogProtections = mutableMapOf<String, Int>()
    private val openLogEditorProtectionTracker = OpenLogEditorProtectionTracker(
        workspaceRoot = workspaceRoot,
        coroutineScope = coroutineScope,
        protectLog = ::protectOpenLog,
    )
    private val inFlightMaterializations = mutableMapOf<MaterializationKey, SharedMaterialization>()
    private val materializationJobs = mutableSetOf<Job>()
    private val selectedMaterializationCount = AtomicInteger()
    private val triageSummaries = ConcurrentHashMap<TriageKey, LogTriageSummary>()

    val state: StateFlow<LogsProjectState> = mutableState.asStateFlow()

    internal var isDisposed: Boolean = false
        private set

    fun refresh() {
        val generation = nextCatalogGeneration()
        refreshJob?.cancel()
        loadMoreJob?.cancel()
        downloadAllJob?.cancel()
        acquisitionJob?.cancel()
        searchJob?.cancel()
        cancelMaterializationJobs()
        synchronized(catalogCommitLock) {
            searchGeneration += 1
            searchMatchOffset = 0
            searchCheckpoint = null
        }
        val previous = mutableState.value
        diagnostics.record("refresh", "started")
        mutableState.update { current -> current.copy(
            isRefreshing = true,
            isLoadingMore = false,
            isDownloadingAll = false,
            isAcquiringBodies = false,
            isMaterializingSelectedLog = false,
            search = current.search.copy(isSearching = false, isRemoteSearching = false),
            failure = null,
        ) }
        refreshJob = coroutineScope.launch {
            withProjectBackgroundProgress(ApexLogViewerBundle.message("progress.refresh")) progress@{
            try {
                val orgs = runtime.orgList(OrgListRequest(workspaceRoot))
                if (!isCurrentCatalog(generation)) return@progress
                val selectedOrg = selectOrg(orgs, previous.selectedOrg ?: settings?.selectedOrg)
                if (selectedOrg == null) {
                    if (!commitCurrentCatalog(generation) {
                        mutableState.update { current ->
                            LogsProjectState(
                                orgs = orgs,
                                viewOptions = current.viewOptions,
                                search = SearchProjectState(query = current.search.query),
                                failure = ProjectFailure(
                                    "no-authenticated-orgs",
                                    "No authenticated Salesforce orgs were found.",
                                ),
                            )
                        }
                    }) {
                        return@progress
                    }
                    diagnostics.record("refresh", "failed", "no-authenticated-orgs")
                    return@progress
                }
                val page = runtime.logPage(
                    LogPageRequest(workspaceRoot, selectedOrg, currentPageSize()),
                )
                val logs = page.logs
                if (!commitCurrentCatalog(generation) {
                    catalogLogs = logs
                    nextCatalogCursor = page.nextCursor
                    settings?.selectedOrg = selectedOrg
                    mutableState.update { current ->
                        LogsProjectState(
                            orgs = orgs,
                            selectedOrg = selectedOrg,
                            logs = visibleCatalogLogs(current.viewOptions, selectedOrg),
                            hasMoreLogs = page.nextCursor != null,
                            availableOperations = availableOperations(),
                            availableStatuses = availableStatuses(),
                            availableUsers = availableUsers(),
                            viewOptions = current.viewOptions,
                            triageByLogId = emptyMap(),
                            search = SearchProjectState(query = current.search.query),
                        )
                    }
                }) {
                    return@progress
                }
                startLoadedPageAcquisition(logs, selectedOrg, generation)
                val refreshedQuery = mutableState.value.search.query
                if (refreshedQuery.isNotEmpty()) {
                    startSearch(refreshedQuery, matchOffset = 0, debounceRemote = true)
                }
                diagnostics.record("refresh", "completed")
                startRetentionPurge(generation, previous.logs.mapTo(mutableSetOf(), LogListRow::id))
            } catch (error: CancellationException) {
                diagnostics.record("refresh", "cancelled")
                throw error
            } catch (error: ApexLogViewerRuntimeException) {
                diagnostics.record("refresh", "failed", error.code)
                if (!commitCurrentCatalog(generation) {
                    mutableState.update { current -> current.copy(
                        isRefreshing = false,
                        isLoadingMore = false,
                        isDownloadingAll = false,
                        isAcquiringBodies = false,
                        isMaterializingSelectedLog = false,
                        search = current.search.copy(isSearching = false, isRemoteSearching = false),
                        failure = ProjectFailure(error.code, error.message ?: "Apex Log Viewer operation failed."),
                    ) }
                }) return@progress
            } catch (_: Exception) {
                diagnostics.record("refresh", "failed", "unexpected")
                if (!commitCurrentCatalog(generation) {
                    mutableState.update { current -> current.copy(
                        isRefreshing = false,
                        isLoadingMore = false,
                        isDownloadingAll = false,
                        isAcquiringBodies = false,
                        isMaterializingSelectedLog = false,
                        search = current.search.copy(isSearching = false, isRemoteSearching = false),
                        failure = ProjectFailure("unexpected", "Apex Log Viewer operation failed."),
                    ) }
                }) return@progress
            }
            }
        }
    }

    fun selectOrg(username: String) {
        val current = mutableState.value
        val selected = current.orgs.firstOrNull { it.username == username }?.username ?: return
        if (selected == current.selectedOrg) return
        settings?.selectedOrg = selected
        searchJob?.cancel()
        loadMoreJob?.cancel()
        downloadAllJob?.cancel()
        cancelMaterializationJobs()
        beforeOrgSelectionInvalidation()
        val staleAcquisition = synchronized(catalogCommitLock) {
            invalidateRetentionLocked()
            catalogGeneration += 1
            acquisitionGeneration += 1
            searchGeneration += 1
            catalogLogs = emptyList()
            nextCatalogCursor = null
            mutableState.update { latest -> latest.copy(
                selectedOrg = selected,
                logs = emptyList(),
                hasMoreLogs = false,
                isLoadingMore = false,
                isDownloadingAll = false,
                isAcquiringBodies = false,
                isMaterializingSelectedLog = false,
                availableOperations = emptyList(),
                availableStatuses = emptyList(),
                availableUsers = emptyList(),
                triageByLogId = triageForOrg(selected),
                search = SearchProjectState(query = latest.search.query),
            ) }
            acquisitionJob.also { acquisitionJob = null }
        }
        staleAcquisition?.cancel()
        afterOrgSelectionInvalidation()
        refresh()
    }

    fun loadMore() {
        val start = synchronized(catalogCommitLock) {
            val cursor = nextCatalogCursor ?: return
            val current = mutableState.value
            val username = current.selectedOrg ?: return
            if (
                current.isLoadingMore || current.isRefreshing || current.isDownloadingAll ||
                current.search.query.isNotEmpty()
            ) return
            mutableState.update { it.copy(isLoadingMore = true, failure = null) }
            CatalogOperationStart(catalogGeneration, username, cursor, catalogLogs)
        }
        loadMoreJob?.cancel()
        diagnostics.record("pagination", "started")
        loadMoreJob = coroutineScope.launch {
            withProjectBackgroundProgress(ApexLogViewerBundle.message("progress.loadMore")) progress@{
            try {
                val page = runtime.logPage(
                    LogPageRequest(workspaceRoot, start.username, currentPageSize(), start.cursor),
                )
                var acquisitionLogs: List<LogListRow> = emptyList()
                if (!commitCurrentCatalog(start.catalogGeneration, start.username) {
                    val knownIds = catalogLogs.mapTo(mutableSetOf(), LogListRow::id)
                    val addedLogs = page.logs.filter { knownIds.add(it.id) }
                    if (addedLogs.isNotEmpty()) invalidateRetentionLocked()
                    catalogLogs = catalogLogs + addedLogs
                    nextCatalogCursor = page.nextCursor
                    acquisitionLogs = catalogLogs
                    mutableState.update { latest ->
                        latest.copy(
                            logs = if (latest.search.query.isEmpty()) {
                                visibleCatalogLogs(latest.viewOptions)
                            } else {
                                latest.logs
                            },
                            isLoadingMore = false,
                            hasMoreLogs = page.nextCursor != null,
                            availableOperations = availableOperations(),
                            availableStatuses = availableStatuses(),
                            availableUsers = availableUsers(),
                        )
                    }
                }) return@progress
                startLoadedPageAcquisition(acquisitionLogs, start.username, start.catalogGeneration)
                diagnostics.record("pagination", "completed")
            } catch (error: CancellationException) {
                diagnostics.record("pagination", "cancelled")
                throw error
            } catch (error: ApexLogViewerRuntimeException) {
                diagnostics.record("pagination", "failed", error.code)
                if (!commitCurrentCatalog(start.catalogGeneration, start.username) {
                    mutableState.update { it.copy(
                        isLoadingMore = false,
                        failure = ProjectFailure(error.code, error.message ?: "Apex log pagination failed."),
                    ) }
                }) return@progress
            } catch (_: Exception) {
                diagnostics.record("pagination", "failed", "unexpected")
                if (!commitCurrentCatalog(start.catalogGeneration, start.username) {
                    mutableState.update { it.copy(
                        isLoadingMore = false,
                        failure = ProjectFailure("unexpected", "Apex log pagination failed."),
                    ) }
                }) return@progress
            }
            }
        }
    }

    fun downloadAll() {
        val start = synchronized(catalogCommitLock) {
            val current = mutableState.value
            val username = current.selectedOrg ?: return
            if (
                current.isDownloadingAll || current.isRefreshing || current.isLoadingMore ||
                current.search.query.isNotEmpty()
            ) return
            mutableState.update { it.copy(
                isDownloadingAll = true,
                downloadProcessed = 0,
                downloadFailureCount = 0,
                failure = null,
            ) }
            CatalogOperationStart(catalogGeneration, username, nextCatalogCursor, catalogLogs)
        }
        downloadAllJob?.cancel()
        diagnostics.record("download", "started")
        val startedAt = Instant.now().toString()
        downloadAllJob = coroutineScope.launch {
            withProjectBackgroundProgress(ApexLogViewerBundle.message("progress.downloadAll")) {
            var cursor = start.cursor
            var nextBodies = start.logs
            var processed = 0
            var failures = 0
            var existing = 0
            var materialized = 0
            var downloaded = 0
            try {
                while (true) {
                    val batch = materializeAndTriageLogs(nextBodies, start.username)
                    processed += batch.attempted
                    failures += batch.failedLogIds.size
                    existing += batch.existingCount
                    materialized += batch.materializedCount
                    downloaded += batch.downloadedCount
                    if (!commitCurrentCatalog(start.catalogGeneration, start.username) {
                        mutableState.update { it.copy(
                            downloadProcessed = processed,
                            downloadFailureCount = failures,
                        ) }
                    }) return@withProjectBackgroundProgress
                    if (cursor == null) break
                    val page = runtime.logPage(
                        LogPageRequest(workspaceRoot, start.username, currentPageSize(), cursor),
                    )
                    if (!commitCurrentCatalog(start.catalogGeneration, start.username) {
                        val knownIds = catalogLogs.mapTo(mutableSetOf(), LogListRow::id)
                        nextBodies = page.logs.filter { knownIds.add(it.id) }
                        if (nextBodies.isNotEmpty()) invalidateRetentionLocked()
                        catalogLogs = catalogLogs + nextBodies
                        cursor = page.nextCursor
                        nextCatalogCursor = cursor
                        mutableState.update { state -> state.copy(
                            logs = if (state.search.query.isEmpty()) {
                                visibleCatalogLogs(state.viewOptions)
                            } else {
                                state.logs
                            },
                            hasMoreLogs = cursor != null,
                            availableOperations = availableOperations(),
                            availableStatuses = availableStatuses(),
                            availableUsers = availableUsers(),
                        ) }
                    }) return@withProjectBackgroundProgress
                }
                val newestLog = synchronized(catalogCommitLock) {
                    if (!isCurrentCatalogLocked(start.catalogGeneration, start.username)) {
                        return@withProjectBackgroundProgress
                    }
                    catalogLogs.firstOrNull()
                }
                runtime.updateSyncState(
                    SyncStateUpdateRequest(
                        workspaceRoot = workspaceRoot,
                        username = start.username,
                        startedAt = startedAt,
                        completedAt = Instant.now().toString(),
                        newestLog = newestLog,
                        existingCount = existing,
                        materializedCount = materialized,
                        downloadedCount = downloaded,
                        failedCount = failures,
                    ),
                )
                if (!commitCurrentCatalog(start.catalogGeneration, start.username) {
                    mutableState.update { it.copy(
                        isDownloadingAll = false,
                        hasMoreLogs = false,
                    ) }
                }) return@withProjectBackgroundProgress
                diagnostics.record("download", if (failures == 0) "completed" else "partial")
            } catch (error: CancellationException) {
                diagnostics.record("download", "cancelled")
                throw error
            } catch (error: ApexLogViewerRuntimeException) {
                diagnostics.record("download", "failed", error.code)
                if (!commitCurrentCatalog(start.catalogGeneration, start.username) {
                    mutableState.update { it.copy(
                        isDownloadingAll = false,
                        failure = ProjectFailure(error.code, error.message ?: "Apex log download failed."),
                    ) }
                }) return@withProjectBackgroundProgress
            } catch (_: Exception) {
                diagnostics.record("download", "failed", "unexpected")
                if (!commitCurrentCatalog(start.catalogGeneration, start.username) {
                    mutableState.update { it.copy(
                        isDownloadingAll = false,
                        failure = ProjectFailure("unexpected", "Apex log download failed."),
                    ) }
                }) return@withProjectBackgroundProgress
            }
            }
        }
    }

    fun cancelDownloadAll() {
        downloadAllJob?.cancel()
        diagnostics.record("download", "cancelled")
        mutableState.update { it.copy(isDownloadingAll = false) }
    }

    fun setSearchQuery(value: String) {
        val query = value
        settings?.searchQuery = query
        synchronized(catalogCommitLock) {
            searchMatchOffset = 0
            searchCheckpoint = null
        }
        if (query.isEmpty()) {
            searchJob?.cancel()
            synchronized(catalogCommitLock) {
                searchGeneration += 1
                mutableState.update { state -> state.copy(
                    logs = visibleCatalogLogs(state.viewOptions),
                    search = SearchProjectState(),
                ) }
            }
            return
        }
        startSearch(query, searchMatchOffset, debounceRemote = true)
    }

    fun continueSearch() {
        val search = mutableState.value.search
        if (!search.canContinue || search.query.isEmpty()) return
        searchMatchOffset += SEARCH_MATCH_BATCH_SIZE
        startSearch(search.query, searchMatchOffset, debounceRemote = false, resumeCheckpoint = true)
    }

    fun cancelSearch() {
        searchJob?.cancel()
        synchronized(catalogCommitLock) {
            searchGeneration += 1
            mutableState.update { it.copy(search = it.search.copy(isSearching = false, isRemoteSearching = false)) }
        }
    }

    fun retrySearch() {
        val query = mutableState.value.search.query
        if (query.isNotEmpty()) {
            startSearch(query, searchMatchOffset, debounceRemote = false, resumeCheckpoint = true)
        }
    }

    fun setViewOptions(value: LogViewOptions) {
        val normalized = value.copy(
            user = value.user?.takeIf(String::isNotBlank),
            operation = value.operation?.takeIf(String::isNotBlank),
            status = value.status?.takeIf(String::isNotBlank),
        )
        val current = mutableState.value
        if (normalized == current.viewOptions) return
        settings?.viewOptions = normalized
        searchJob?.cancel()
        synchronized(catalogCommitLock) {
            searchMatchOffset = 0
            searchCheckpoint = null
            searchGeneration += 1
            mutableState.update { latest -> latest.copy(
                logs = visibleCatalogLogs(normalized),
                viewOptions = normalized,
                failure = null,
                search = SearchProjectState(query = latest.search.query),
            ) }
        }
        if (current.search.query.isNotEmpty()) {
            startSearch(current.search.query, matchOffset = 0, debounceRemote = true)
        }
    }

    private fun startSearch(
        query: String,
        matchOffset: Int,
        debounceRemote: Boolean,
        resumeCheckpoint: Boolean = false,
    ) {
        searchJob?.cancel()
        loadMoreJob?.cancel()
        if (downloadAllJob?.isActive == true) {
            downloadAllJob?.cancel()
            diagnostics.record("download", "cancelled")
        }
        val start = synchronized(catalogCommitLock) {
            searchGeneration += 1
            val epoch = SearchEpoch(searchGeneration, catalogGeneration)
            val current = mutableState.value
            val username = current.selectedOrg
            if (!resumeCheckpoint) searchCheckpoint = null
            if (username == null) {
                mutableState.update { it.copy(
                    logs = emptyList(),
                    search = SearchProjectState(query = query),
                ) }
                null
            } else {
                mutableState.update { it.copy(
                    isLoadingMore = false,
                    isDownloadingAll = false,
                    failure = null,
                    search = SearchProjectState(query = query, isSearching = true, matchOffset = matchOffset),
                ) }
                SearchStart(epoch, username, current.viewOptions)
            }
        } ?: return
        val epoch = start.epoch
        val viewOptions = start.viewOptions
        val username = start.username
        diagnostics.record("search", "started")
        searchJob = coroutineScope.launch {
            withProjectBackgroundProgress(
                ApexLogViewerBundle.message("progress.search").takeIf { query.length >= MIN_REMOTE_SEARCH_QUERY_LENGTH },
            ) progress@{
            try {
                val remoteEligible = query.length >= MIN_REMOTE_SEARCH_QUERY_LENGTH
                val initialSnapshot = currentSearchCatalogSnapshot(
                    epoch,
                    query,
                    viewOptions,
                    resumeCheckpoint = false,
                    requiresSortedPass = false,
                    username = username,
                ) ?: return@progress
                if (viewOptions.errorsOnly) {
                    triageDependableLocalLogs(metadataFilter(initialSnapshot.logs, viewOptions), username)
                }
                var completed = runtime.searchLocalLogs(
                    LocalLogSearchRequest(
                        workspaceRoot,
                        username,
                        query,
                        filterAndSort(initialSnapshot.logs, viewOptions),
                        currentProcessingConcurrency(),
                    ),
                )
                if (!isCurrentSearch(epoch, query, viewOptions)) return@progress
                publishSearchProgress(
                    epoch = epoch,
                    viewOptions = viewOptions,
                    query = query,
                    result = completed,
                    pagesExamined = 1,
                    bodiesProcessed = 0,
                    failedLogIds = completed.failedLogIds.toSet(),
                    cursor = initialSnapshot.cursor,
                    isSearching = false,
                    isRemoteSearching = false,
                    matchOffset = matchOffset,
                )
                if (!remoteEligible) {
                    diagnostics.record("search", if (completed.failedLogIds.isEmpty()) "completed" else "partial")
                    return@progress
                }
                if (debounceRemote) delay(REMOTE_SEARCH_DEBOUNCE_MS)
                if (!commitCurrentSearch(epoch, query, viewOptions) {
                    mutableState.update {
                        it.copy(search = it.search.copy(isSearching = true, isRemoteSearching = true))
                    }
                }) return@progress
                val requiresSortedPass = viewOptions.sortField != LogSortField.START_TIME ||
                    viewOptions.sortDirection != LogSortDirection.DESCENDING
                val remoteSnapshot = currentSearchCatalogSnapshot(
                    epoch,
                    query,
                    viewOptions,
                    resumeCheckpoint,
                    requiresSortedPass,
                    username,
                ) ?: return@progress
                val resumed = remoteSnapshot.checkpoint
                var bodiesProcessed = resumed?.bodiesProcessed ?: 0
                val materializationFailures = linkedSetOf<String>()
                val initialPending = completed.pendingLogIds.mapNotNull { logId ->
                    if (!isCurrentSearch(epoch, query, viewOptions)) return@progress
                    remoteSnapshot.logs.firstOrNull { it.id == logId }
                }
                val resumedFailedLogs = resumed?.failedLogIds.orEmpty().mapNotNull { logId ->
                    resumed?.logs?.firstOrNull { it.id == logId }
                        ?: remoteSnapshot.logs.firstOrNull { it.id == logId }
                }
                val retryableFailureIds = resumedFailedLogs.mapTo(mutableSetOf(), LogListRow::id)
                materializationFailures += resumed?.failedLogIds.orEmpty() - retryableFailureIds
                val initialBatch = if (resumed != null && resumedFailedLogs.isNotEmpty()) {
                    if (viewOptions.errorsOnly) {
                        materializeAndTriageLogs(resumedFailedLogs, username)
                    } else {
                        materializeLogs(resumedFailedLogs, username)
                    }
                } else if (resumed != null || requiresSortedPass) {
                    MaterializationBatchResult(0, emptyList())
                } else if (viewOptions.errorsOnly) {
                    materializeAndTriageLogs(metadataFilter(remoteSnapshot.logs, viewOptions), username)
                } else {
                    materializeLogs(initialPending, username)
                }
                bodiesProcessed += initialBatch.attempted
                materializationFailures += initialBatch.failedLogIds
                if (!isCurrentSearch(epoch, query, viewOptions)) return@progress
                completed = runtime.searchLocalLogs(
                    LocalLogSearchRequest(
                        workspaceRoot,
                        username,
                        query,
                        filterAndSort(remoteSnapshot.logs, viewOptions),
                        currentProcessingConcurrency(),
                    ),
                )
                var pagesExamined = resumed?.pagesExamined ?: 1
                var searchPassLogs = resumed?.logs ?: if (requiresSortedPass) emptyList() else remoteSnapshot.logs
                var cursor = resumed?.cursor ?: if (requiresSortedPass) null else remoteSnapshot.cursor
                var canFetchPage = if (resumed != null) cursor != null else requiresSortedPass || cursor != null
                if (requiresSortedPass) {
                    completed = runtime.searchLocalLogs(
                        LocalLogSearchRequest(
                            workspaceRoot,
                            username,
                            query,
                            filterAndSort(searchPassLogs, viewOptions),
                            currentProcessingConcurrency(),
                        ),
                    )
                }
                while (
                    completed.matches.size < matchOffset + SEARCH_MATCH_BATCH_SIZE && canFetchPage
                ) {
                    if (!isCurrentSearch(epoch, query, viewOptions)) return@progress
                    val page = runtime.logPage(
                        LogPageRequest(
                            workspaceRoot = workspaceRoot,
                            username = username,
                            limit = currentPageSize(),
                            cursor = cursor,
                            sortField = viewOptions.sortField.toRuntimeSortField(),
                            sortDirection = viewOptions.sortDirection.toRuntimeSortDirection(),
                        ),
                    )
                    var passLogs: List<LogListRow> = emptyList()
                    if (!commitCurrentSearch(epoch, query, viewOptions) {
                        pagesExamined += 1
                        val knownIds = catalogLogs.mapTo(mutableSetOf(), LogListRow::id)
                        val addedLogs = page.logs.filter { knownIds.add(it.id) }
                        if (addedLogs.isNotEmpty()) invalidateRetentionLocked()
                        catalogLogs = catalogLogs + addedLogs
                        cursor = page.nextCursor
                        canFetchPage = cursor != null
                        if (!requiresSortedPass) nextCatalogCursor = cursor
                        passLogs = if (requiresSortedPass) page.logs else addedLogs
                        if (requiresSortedPass) {
                            val passIds = searchPassLogs.mapTo(mutableSetOf(), LogListRow::id)
                            searchPassLogs = searchPassLogs + passLogs.filter { passIds.add(it.id) }
                        } else {
                            searchPassLogs = catalogLogs
                        }
                    }) return@progress
                    if (viewOptions.errorsOnly) {
                        val batch = materializeAndTriageLogs(metadataFilter(passLogs, viewOptions), username)
                        bodiesProcessed += batch.attempted
                        materializationFailures += batch.failedLogIds
                    }
                    val pageSearch = runtime.searchLocalLogs(
                        LocalLogSearchRequest(
                            workspaceRoot,
                            username,
                            query,
                            filterAndSort(passLogs, viewOptions),
                            currentProcessingConcurrency(),
                        ),
                    )
                    if (!viewOptions.errorsOnly) {
                        val pagePending = pageSearch.pendingLogIds.mapNotNull { logId ->
                            if (!isCurrentSearch(epoch, query, viewOptions)) return@progress
                            passLogs.firstOrNull { it.id == logId }
                        }
                        val batch = materializeLogs(pagePending, username)
                        bodiesProcessed += batch.attempted
                        materializationFailures += batch.failedLogIds
                    }
                    completed = runtime.searchLocalLogs(
                        LocalLogSearchRequest(
                            workspaceRoot,
                            username,
                            query,
                            filterAndSort(searchPassLogs, viewOptions),
                            currentProcessingConcurrency(),
                        ),
                    )
                    if (requiresSortedPass) {
                        if (!commitCurrentSearch(epoch, query, viewOptions, isCheckpoint = true) {
                            searchCheckpoint = ProgressiveSearchCheckpoint(
                                username = username,
                                query = query,
                                viewOptions = viewOptions,
                                catalogGeneration = epoch.catalogGeneration,
                                logs = searchPassLogs,
                                cursor = cursor,
                                pagesExamined = pagesExamined,
                                bodiesProcessed = bodiesProcessed,
                                failedLogIds = materializationFailures.toSet(),
                            )
                        }) return@progress
                    }
                    val failedLogIds = materializationFailures + completed.failedLogIds
                    publishSearchProgress(
                        epoch,
                        viewOptions,
                        query,
                        completed,
                        pagesExamined,
                        bodiesProcessed,
                        failedLogIds,
                        cursor,
                        isSearching = true,
                        isRemoteSearching = true,
                        matchOffset = matchOffset,
                    )
                }
                if (requiresSortedPass) {
                    if (!commitCurrentSearch(epoch, query, viewOptions, isCheckpoint = true) {
                        searchCheckpoint = ProgressiveSearchCheckpoint(
                            username = username,
                            query = query,
                            viewOptions = viewOptions,
                            catalogGeneration = epoch.catalogGeneration,
                            logs = searchPassLogs,
                            cursor = cursor,
                            pagesExamined = pagesExamined,
                            bodiesProcessed = bodiesProcessed,
                            failedLogIds = materializationFailures.toSet(),
                        )
                    }) return@progress
                }
                publishSearchProgress(
                    epoch,
                    viewOptions,
                    query,
                    completed,
                    pagesExamined,
                    bodiesProcessed,
                    materializationFailures + completed.failedLogIds,
                    cursor,
                    isSearching = false,
                    isRemoteSearching = false,
                    matchOffset = matchOffset,
                )
                diagnostics.record(
                    "search",
                    if (materializationFailures.isEmpty() && completed.failedLogIds.isEmpty()) "completed" else "partial",
                )
            } catch (error: CancellationException) {
                diagnostics.record("search", "cancelled")
                throw error
            } catch (error: ApexLogViewerRuntimeException) {
                diagnostics.record("search", "failed", error.code)
                if (!commitCurrentSearch(epoch, query, viewOptions) {
                    mutableState.update { latest -> latest.copy(
                        search = latest.search.copy(
                            isSearching = false,
                            isRemoteSearching = false,
                            canContinue = false,
                        ),
                        failure = ProjectFailure(error.code, error.message ?: "Apex log search failed."),
                    ) }
                }) return@progress
            } catch (_: Exception) {
                diagnostics.record("search", "failed", "unexpected")
                if (!commitCurrentSearch(epoch, query, viewOptions) {
                    mutableState.update { latest -> latest.copy(
                        search = latest.search.copy(
                            isSearching = false,
                            isRemoteSearching = false,
                            canContinue = false,
                        ),
                        failure = ProjectFailure("unexpected", "Apex log search failed."),
                    ) }
                }) return@progress
            }
            }
        }
    }

    fun materializeLog(log: LogListRow, completion: (Result<LocalLogFile>) -> Unit) {
        val username = mutableState.value.selectedOrg
        if (username == null) {
            completion(Result.failure(ApexLogViewerRuntimeException("org-resolution", "A target org is required.")))
            return
        }
        val job = coroutineScope.launch {
            diagnostics.record("materialization", "started")
            selectedMaterializationCount.incrementAndGet()
            mutableState.update { it.copy(isMaterializingSelectedLog = true) }
            try {
                val local = withProjectBackgroundProgress(
                    ApexLogViewerBundle.message("progress.materializeSelected"),
                ) {
                    requireSharedLocalLog(log, username)
                }
                if (mutableState.value.selectedOrg == username) completion(Result.success(local))
                diagnostics.record("materialization", "completed")
            } catch (error: CancellationException) {
                diagnostics.record("materialization", "cancelled")
                throw error
            } catch (error: Exception) {
                diagnostics.record("materialization", "failed", (error as? ApexLogViewerRuntimeException)?.code)
                if (mutableState.value.selectedOrg == username) completion(Result.failure(error))
            } finally {
                val remaining = selectedMaterializationCount.decrementAndGet().coerceAtLeast(0)
                mutableState.update { it.copy(isMaterializingSelectedLog = remaining > 0) }
            }
        }
        synchronized(materializationJobs) { materializationJobs += job }
        job.invokeOnCompletion { synchronized(materializationJobs) { materializationJobs -= job } }
    }

    fun recognizeExternalLog(file: VirtualFile, completion: (Boolean) -> Unit) {
        val project = intellijProject?.takeUnless { it.isDisposed } ?: return
        if (!file.isInLocalFileSystem || file.extension?.equals("log", ignoreCase = true) != true) return
        val path = runCatching(file::toNioPath).getOrNull() ?: return
        coroutineScope.launch {
            val recognized = withProjectBackgroundProgress(ApexLogViewerBundle.message("progress.recognizeLog")) {
                withContext(Dispatchers.IO) { hasBoundedApexLogMarker(path) }
            }
            ApplicationManager.getApplication().invokeLater {
                if (!project.isDisposed && file.isValid) completion(recognized)
            }
        }
    }

    fun buildDiagnosticsPackage(completion: (Result<String>) -> Unit) {
        val project = intellijProject?.takeUnless { it.isDisposed } ?: return
        val snapshot = mutableState.value
        coroutineScope.launch {
            val result = runCatching {
                withProjectBackgroundProgress(ApexLogViewerBundle.message("progress.diagnostics")) {
                    withContext(Dispatchers.IO) { diagnostics.sanitizedPackage(project, snapshot) }
                }
            }
            ApplicationManager.getApplication().invokeLater {
                if (!project.isDisposed) completion(result)
            }
        }
    }

    fun saveDiagnosticsPackage(path: Path, content: String, completion: (Result<Path>) -> Unit) {
        val project = intellijProject?.takeUnless { it.isDisposed } ?: return
        coroutineScope.launch {
            val result = runCatching {
                withProjectBackgroundProgress(ApexLogViewerBundle.message("progress.saveDiagnostics")) {
                    withContext(Dispatchers.IO) {
                        Files.writeString(path, content)
                        path
                    }
                }
            }
            ApplicationManager.getApplication().invokeLater {
                if (!project.isDisposed) completion(result)
            }
        }
    }

    fun protectOpenLog(logId: String): AutoCloseable {
        synchronized(catalogCommitLock) {
            synchronized(openLogProtections) {
                openLogProtections[logId] = openLogProtections.getOrDefault(logId, 0) + 1
            }
            invalidateRetentionLocked()
        }
        return AutoCloseable {
            synchronized(openLogProtections) {
                val remaining = openLogProtections.getOrDefault(logId, 0) - 1
                if (remaining <= 0) openLogProtections.remove(logId) else openLogProtections[logId] = remaining
            }
        }
    }

    private fun protectedLogIds(): Set<String> = synchronized(openLogProtections) {
        openLogProtections.keys.toSet()
    }

    private fun invalidateRetentionLocked() {
        retentionGeneration += 1
        purgeJob?.cancel()
        purgeJob = null
    }

    private fun startRetentionPurge(catalog: Long, previousLogIds: Set<String>) {
        val epoch = synchronized(catalogCommitLock) {
            if (!isCurrentCatalogLocked(catalog, null) || isDisposed) return
            invalidateRetentionLocked()
            RetentionEpoch(catalog, retentionGeneration)
        }
        val job = coroutineScope.launch(start = CoroutineStart.LAZY) {
            try {
                val protectedSnapshot = retentionProtectionSnapshot(epoch, previousLogIds) ?: return@launch
                runtime.purgeLocalLogs(
                    PurgeLocalLogsRequest(
                        workspaceRoot = workspaceRoot,
                        protectedLogIds = protectedSnapshot,
                        deletionGuard = PurgeDeletionGuard { logId, delete ->
                            deleteLogIfUnprotectedForRetention(epoch, logId, delete)
                        },
                    ),
                )
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                // Retention maintenance is best-effort and never delays or hides an authoritative catalog.
            } finally {
                afterRetentionPurge()
            }
        }
        val registered = synchronized(catalogCommitLock) {
            if (
                !isDisposed && retentionGeneration == epoch.retentionGeneration &&
                isCurrentCatalogLocked(epoch.catalogGeneration, null)
            ) {
                purgeJob = job
                true
            } else {
                false
            }
        }
        if (registered) {
            job.invokeOnCompletion {
                synchronized(catalogCommitLock) {
                    if (purgeJob === job) purgeJob = null
                }
            }
            job.start()
        } else {
            job.cancel()
        }
    }

    private fun retentionProtectionSnapshot(epoch: RetentionEpoch, previousLogIds: Set<String>): Set<String>? {
        val catalogLogIds = synchronized(catalogCommitLock) {
            if (
                isDisposed || retentionGeneration != epoch.retentionGeneration ||
                !isCurrentCatalogLocked(epoch.catalogGeneration, null)
            ) return null
            catalogLogs.mapTo(mutableSetOf(), LogListRow::id)
        }
        return previousLogIds + catalogLogIds + protectedLogIds()
    }

    private fun deleteLogIfUnprotectedForRetention(
        epoch: RetentionEpoch,
        logId: String,
        delete: () -> Boolean,
    ): PurgeDeletionOutcome {
        beforeRetentionProtectionCheck(logId)
        return synchronized(catalogCommitLock) {
            synchronized(openLogProtections) {
                val isProtected = isDisposed || retentionGeneration != epoch.retentionGeneration ||
                    !isCurrentCatalogLocked(epoch.catalogGeneration, null) ||
                    catalogLogs.any { it.id == logId } || logId in openLogProtections
                if (isProtected) {
                    PurgeDeletionOutcome.PROTECTED
                } else {
                    afterRetentionDeletionValidation(logId)
                    if (delete()) PurgeDeletionOutcome.DELETED else PurgeDeletionOutcome.MISSING
                }
            }
        }
    }

    private fun registerOpenLogProtection(project: Project) {
        fun protect(file: VirtualFile) {
            if (!file.isInLocalFileSystem) return
            openLogEditorProtectionTracker.fileOpened(file, file.path)
        }

        fun release(file: VirtualFile) = openLogEditorProtectionTracker.fileClosed(file)

        project.messageBus.connect(this).subscribe(
            FileEditorManagerListener.FILE_EDITOR_MANAGER,
            object : FileEditorManagerListener {
                override fun fileOpened(source: FileEditorManager, file: VirtualFile) = protect(file)

                override fun fileClosed(source: FileEditorManager, file: VirtualFile) = release(file)
            },
        )
        FileEditorManager.getInstance(project).openFiles.forEach(::protect)
    }

    private suspend fun materializeLogs(logs: List<LogListRow>, username: String): MaterializationBatchResult {
        var result = MaterializationBatchResult()
        logs.chunked(currentProcessingConcurrency()).forEach { chunk ->
            val outcomes = coroutineScope {
                chunk.map { log ->
                    async {
                        try {
                            MaterializationOutcome(log.id, requireSharedLocalLog(log, username))
                        } catch (error: CancellationException) {
                            throw error
                        } catch (_: Exception) {
                            MaterializationOutcome(log.id, failed = true)
                        }
                    }
                }.awaitAll()
            }
            result += outcomes.toBatchResult()
        }
        return result
    }

    private fun startLoadedPageAcquisition(logs: List<LogListRow>, username: String, catalog: Long) {
        if (!backgroundAcquisition || logs.isEmpty()) return
        val acquisition = synchronized(catalogCommitLock) {
            if (!isCurrentCatalogLocked(catalog, username)) return
            acquisitionGeneration += 1
            acquisitionJob?.cancel()
            mutableState.update { it.copy(
                isAcquiringBodies = true,
                acquisitionProcessed = 0,
                acquisitionFailureCount = 0,
            ) }
            acquisitionGeneration
        }
        diagnostics.record("acquisition", "started")
        val job = coroutineScope.launch(start = CoroutineStart.LAZY) {
            withProjectBackgroundProgress(ApexLogViewerBundle.message("progress.acquisition")) {
            try {
                val batch = materializeAndTriageLogs(logs, username) { currentProcessed, currentFailed ->
                    if (!commitCurrentAcquisition(acquisition, catalog, username) {
                        mutableState.update { it.copy(
                            acquisitionProcessed = currentProcessed,
                            acquisitionFailureCount = currentFailed,
                            triageByLogId = triageForOrg(username),
                        ) }
                        republishVisibleCatalogIfIdle(username)
                    }) return@materializeAndTriageLogs
                }
                if (!commitCurrentAcquisition(acquisition, catalog, username) {
                    mutableState.update { it.copy(
                        isAcquiringBodies = false,
                        acquisitionProcessed = batch.attempted,
                        acquisitionFailureCount = batch.failedLogIds.size,
                        triageByLogId = triageForOrg(username),
                    ) }
                    republishVisibleCatalogIfIdle(username)
                }) return@withProjectBackgroundProgress
                diagnostics.record("acquisition", if (batch.failedLogIds.isEmpty()) "completed" else "partial")
            } catch (error: CancellationException) {
                diagnostics.record("acquisition", "cancelled")
                throw error
            } catch (_: Exception) {
                diagnostics.record("acquisition", "failed", "unexpected")
                if (!commitCurrentAcquisition(acquisition, catalog, username) {
                    mutableState.update { it.copy(isAcquiringBodies = false) }
                }) return@withProjectBackgroundProgress
            }
            }
        }
        beforeAcquisitionJobRegistration(catalog, username)
        val registered = synchronized(catalogCommitLock) {
            if (acquisitionGeneration == acquisition && isCurrentCatalogLocked(catalog, username)) {
                acquisitionJob = job
                true
            } else {
                false
            }
        }
        if (registered) {
            job.invokeOnCompletion {
                synchronized(catalogCommitLock) {
                    if (acquisitionJob === job) acquisitionJob = null
                }
            }
            job.start()
        } else {
            job.cancel()
        }
    }

    private suspend fun materializeAndTriageLogs(
        logs: List<LogListRow>,
        username: String,
        onProgress: (Int, Int) -> Unit = { _, _ -> },
    ): MaterializationBatchResult {
        var result = MaterializationBatchResult()
        logs.chunked(currentProcessingConcurrency()).forEach { chunk ->
            val outcomes = coroutineScope {
                chunk.map { log ->
                    async {
                        try {
                            val local = requireSharedLocalLog(log, username)
                            val key = TriageKey(username, log.id)
                            val triage = triageSummaries[key] ?: runtime.triageLog(ParseLogRequest(local.localPath))
                            beforeTriageSummaryCommit(username, log.id)
                            triageSummaries[key] = triage
                            afterTriageSummaryCommit(username, log.id)
                            MaterializationOutcome(log.id, local)
                        } catch (error: CancellationException) {
                            throw error
                        } catch (_: Exception) {
                            MaterializationOutcome(log.id, failed = true)
                        }
                    }
                }.awaitAll()
            }
            result += outcomes.toBatchResult()
            onProgress(result.attempted, result.failedLogIds.size)
        }
        return result
    }

    private suspend fun triageDependableLocalLogs(
        logs: List<LogListRow>,
        username: String,
    ): MaterializationBatchResult {
        var attempted = 0
        val failedLogIds = mutableListOf<String>()
        logs.chunked(currentProcessingConcurrency()).forEach { chunk ->
            val outcomes = coroutineScope {
                chunk.map { log ->
                    async {
                        try {
                            val local = runtime.findLocalLog(RequireLocalLogRequest(workspaceRoot, username, log))
                                ?: return@async LocalTriageOutcome(log.id, attempted = false)
                            val key = TriageKey(username, log.id)
                            val triage = triageSummaries[key] ?: runtime.triageLog(ParseLogRequest(local.localPath))
                            beforeTriageSummaryCommit(username, log.id)
                            triageSummaries[key] = triage
                            afterTriageSummaryCommit(username, log.id)
                            LocalTriageOutcome(log.id, attempted = true)
                        } catch (error: CancellationException) {
                            throw error
                        } catch (_: Exception) {
                            LocalTriageOutcome(log.id, attempted = true, failed = true)
                        }
                    }
                }.awaitAll()
            }
            attempted += outcomes.count(LocalTriageOutcome::attempted)
            failedLogIds += outcomes.filter(LocalTriageOutcome::failed).map(LocalTriageOutcome::logId)
        }
        return MaterializationBatchResult(
            attempted = attempted,
            failedLogIds = failedLogIds,
            existingCount = attempted - failedLogIds.size,
        )
    }

    private suspend fun requireSharedLocalLog(log: LogListRow, username: String): LocalLogFile {
        val key = MaterializationKey(username, log.id)
        val shared = synchronized(inFlightMaterializations) {
            inFlightMaterializations[key]?.let {
                it.consumers += 1
                return@synchronized it
            }
            val deferred = coroutineScope.async {
                runtime.requireLocalLog(RequireLocalLogRequest(workspaceRoot, username, log))
            }
            SharedMaterialization(deferred, consumers = 1).also { inFlightMaterializations[key] = it }
        }
        try {
            return shared.deferred.await()
        } finally {
            synchronized(inFlightMaterializations) {
                shared.consumers -= 1
                if (shared.consumers == 0) {
                    if (inFlightMaterializations[key] === shared) inFlightMaterializations.remove(key)
                    if (shared.deferred.isActive) shared.deferred.cancel()
                }
            }
        }
    }

    private fun republishVisibleCatalogIfIdle(username: String) {
        mutableState.update { current ->
            if (current.search.query.isNotEmpty()) return@update current
            current.copy(
                logs = visibleCatalogLogs(current.viewOptions, username),
                triageByLogId = triageForOrg(username),
            )
        }
    }

    private fun publishSearchProgress(
        epoch: SearchEpoch,
        viewOptions: LogViewOptions,
        query: String,
        result: com.electivus.apexlogviewer.runtime.LocalLogSearchResult,
        pagesExamined: Int,
        bodiesProcessed: Int,
        failedLogIds: Set<String>,
        cursor: LogCursor?,
        isSearching: Boolean,
        isRemoteSearching: Boolean,
        matchOffset: Int,
    ) {
        val matches = result.matches.drop(matchOffset).take(SEARCH_MATCH_BATCH_SIZE)
        val pendingLogIds = result.pendingLogIds.filterNot(failedLogIds::contains)
        val visibleIds = (matches.map(LogSearchMatch::logId) + pendingLogIds + failedLogIds).toSet()
        commitCurrentSearch(epoch, query, viewOptions) {
            mutableState.update { current ->
                current.copy(
                    logs = searchVisibleLogs(viewOptions, visibleIds, failedLogIds),
                    triageByLogId = triageForOrg(current.selectedOrg),
                    search = SearchProjectState(
                        query = query,
                        isSearching = isSearching,
                        isRemoteSearching = isRemoteSearching,
                        matches = matches,
                        pendingLogIds = pendingLogIds,
                        failedLogIds = failedLogIds.toList(),
                        pagesExamined = pagesExamined,
                        bodiesProcessed = bodiesProcessed,
                        partialFailureCount = failedLogIds.size,
                        matchOffset = matchOffset,
                        totalMatches = result.matches.size,
                        snapshotExhausted = cursor == null,
                        canContinue = result.matches.size > matchOffset + matches.size ||
                            (query.length >= MIN_REMOTE_SEARCH_QUERY_LENGTH && cursor != null),
                    ),
                )
            }
        }
    }

    override fun dispose() {
        synchronized(catalogCommitLock) {
            isDisposed = true
            invalidateRetentionLocked()
        }
        refreshJob?.cancel()
        searchJob?.cancel()
        loadMoreJob?.cancel()
        downloadAllJob?.cancel()
        acquisitionJob?.cancel()
        cancelMaterializationJobs()
        synchronized(inFlightMaterializations) {
            inFlightMaterializations.values.forEach { it.deferred.cancel() }
            inFlightMaterializations.clear()
        }
        openLogEditorProtectionTracker.dispose()
        coroutineScope.cancel()
        runtime.close()
    }

    private fun selectOrg(orgs: List<OrgListItem>, current: String?): String? {
        val selected = current?.trim()?.takeIf(String::isNotEmpty)
        return orgs.firstOrNull { it.username == selected || it.alias == selected }?.username
            ?: orgs.firstOrNull(OrgListItem::isDefaultUsername)?.username
            ?: orgs.firstOrNull()?.username
    }

    private fun isCurrentSearch(epoch: SearchEpoch, query: String, viewOptions: LogViewOptions): Boolean =
        synchronized(catalogCommitLock) {
            isCurrentSearchLocked(epoch, query, viewOptions)
        }

    private fun currentSearchCatalogSnapshot(
        epoch: SearchEpoch,
        query: String,
        viewOptions: LogViewOptions,
        resumeCheckpoint: Boolean,
        requiresSortedPass: Boolean,
        username: String,
    ): SearchCatalogSnapshot? = synchronized(catalogCommitLock) {
        if (!isCurrentSearchLocked(epoch, query, viewOptions)) return@synchronized null
        val checkpoint = searchCheckpoint?.takeIf { candidate ->
            requiresSortedPass && resumeCheckpoint && candidate.username == username &&
                candidate.query == query && candidate.viewOptions == viewOptions &&
                candidate.catalogGeneration == epoch.catalogGeneration
        }
        SearchCatalogSnapshot(catalogLogs, nextCatalogCursor, checkpoint)
    }

    private fun nextCatalogGeneration(): Long = synchronized(catalogCommitLock) {
        invalidateRetentionLocked()
        catalogGeneration += 1
        catalogGeneration
    }

    private fun isCurrentCatalog(generation: Long, username: String? = null): Boolean =
        synchronized(catalogCommitLock) {
            isCurrentCatalogLocked(generation, username)
        }

    private inline fun commitCurrentCatalog(
        generation: Long,
        username: String? = null,
        mutation: () -> Unit,
    ): Boolean = synchronized(catalogCommitLock) {
        if (!isCurrentCatalogLocked(generation, username)) {
            afterCatalogCommitRejection(generation)
            return@synchronized false
        }
        afterCatalogCommitValidation(generation)
        mutation()
        true
    }

    private inline fun commitCurrentSearch(
        epoch: SearchEpoch,
        query: String,
        viewOptions: LogViewOptions,
        isCheckpoint: Boolean = false,
        mutation: () -> Unit,
    ): Boolean = synchronized(catalogCommitLock) {
        if (!isCurrentSearchLocked(epoch, query, viewOptions)) {
            afterCatalogCommitRejection(epoch.catalogGeneration)
            return@synchronized false
        }
        afterCatalogCommitValidation(epoch.catalogGeneration)
        if (isCheckpoint) afterSearchCheckpointValidation(epoch.catalogGeneration)
        mutation()
        true
    }

    private fun isCurrentCatalogLocked(generation: Long, username: String?): Boolean =
        catalogGeneration == generation && (username == null || mutableState.value.selectedOrg == username)

    private fun isCurrentSearchLocked(epoch: SearchEpoch, query: String, viewOptions: LogViewOptions): Boolean =
        catalogGeneration == epoch.catalogGeneration && searchGeneration == epoch.searchGeneration &&
            mutableState.value.search.query == query && mutableState.value.viewOptions == viewOptions

    private inline fun commitCurrentAcquisition(
        acquisition: Long,
        catalog: Long,
        username: String,
        mutation: () -> Unit,
    ): Boolean = synchronized(catalogCommitLock) {
        if (acquisitionGeneration != acquisition || !isCurrentCatalogLocked(catalog, username)) {
            afterCatalogCommitRejection(catalog)
            return@synchronized false
        }
        afterAcquisitionCommitValidation(catalog, username)
        mutation()
        true
    }

    private fun visibleCatalogLogs(
        viewOptions: LogViewOptions,
        username: String? = mutableState.value.selectedOrg,
    ): List<LogListRow> = filterAndSort(catalogLogs, viewOptions, username)

    private fun searchVisibleLogs(
        viewOptions: LogViewOptions,
        visibleIds: Set<String>,
        failedLogIds: Set<String>,
    ): List<LogListRow> = sortLogs(
        metadataFilter(catalogLogs, viewOptions).filter { log ->
            log.id in visibleIds &&
                (
                    !viewOptions.errorsOnly || log.id in failedLogIds ||
                        log.status?.equals("Success", ignoreCase = true) == false ||
                        triageSummary(mutableState.value.selectedOrg, log.id)?.hasErrors == true
                    )
        },
        viewOptions,
    )

    private fun filterAndSort(
        logs: List<LogListRow>,
        viewOptions: LogViewOptions,
        username: String? = mutableState.value.selectedOrg,
    ): List<LogListRow> {
        val filtered = metadataFilter(logs, viewOptions).filter { log ->
            !viewOptions.errorsOnly ||
                log.status?.equals("Success", ignoreCase = true) == false ||
                triageSummary(username, log.id)?.hasErrors == true
        }
        return sortLogs(filtered, viewOptions)
    }

    private fun sortLogs(logs: List<LogListRow>, viewOptions: LogViewOptions): List<LogListRow> {
        val comparator = when (viewOptions.sortField) {
            LogSortField.START_TIME -> compareBy<LogListRow>({ it.startTime.orEmpty() }, LogListRow::id)
            LogSortField.OPERATION -> compareBy<LogListRow>({ it.operation.orEmpty() }, LogListRow::id)
            LogSortField.STATUS -> compareBy<LogListRow>({ it.status.orEmpty() }, LogListRow::id)
            LogSortField.SIZE -> compareBy<LogListRow>({ it.logLength ?: 0 }, LogListRow::id)
            LogSortField.LOG_ID -> compareBy(LogListRow::id)
        }
        return logs.sortedWith(
            if (viewOptions.sortDirection == LogSortDirection.ASCENDING) comparator else comparator.reversed(),
        )
    }

    private fun metadataFilter(logs: List<LogListRow>, viewOptions: LogViewOptions): List<LogListRow> =
        logs.filter { log ->
            (viewOptions.operation == null || log.operation == viewOptions.operation) &&
                (viewOptions.status == null || log.status == viewOptions.status) &&
                (viewOptions.user == null || log.logUser == viewOptions.user)
        }

    private fun triageSummary(username: String?, logId: String): LogTriageSummary? =
        username?.let { triageSummaries[TriageKey(it, logId)] }

    private fun triageForOrg(username: String?): Map<String, LogTriageSummary> =
        username?.let { selected ->
            triageSummaries.entries.asSequence()
                .filter { it.key.username == selected }
                .associate { it.key.logId to it.value }
        }.orEmpty()

    private fun availableOperations(): List<String> =
        catalogLogs.mapNotNull(LogListRow::operation).distinct().sortedWith(String.CASE_INSENSITIVE_ORDER)

    private fun availableStatuses(): List<String> =
        catalogLogs.mapNotNull(LogListRow::status).distinct().sortedWith(String.CASE_INSENSITIVE_ORDER)

    private fun availableUsers(): List<String> =
        catalogLogs.mapNotNull(LogListRow::logUser).distinct().sortedWith(String.CASE_INSENSITIVE_ORDER)

    private fun currentPageSize(): Int = applicationSettings?.pageSize ?: pageSize.coerceIn(1, 200)

    private fun currentProcessingConcurrency(): Int =
        applicationSettings?.processingConcurrency ?: processingConcurrency.coerceIn(1, 16)

    private fun LogSortField.toRuntimeSortField(): LogPageSortField = when (this) {
        LogSortField.START_TIME -> LogPageSortField.START_TIME
        LogSortField.OPERATION -> LogPageSortField.OPERATION
        LogSortField.STATUS -> LogPageSortField.STATUS
        LogSortField.SIZE -> LogPageSortField.SIZE
        LogSortField.LOG_ID -> LogPageSortField.LOG_ID
    }

    private fun LogSortDirection.toRuntimeSortDirection(): LogPageSortDirection = when (this) {
        LogSortDirection.ASCENDING -> LogPageSortDirection.ASCENDING
        LogSortDirection.DESCENDING -> LogPageSortDirection.DESCENDING
    }

    private suspend fun <T> withProjectBackgroundProgress(
        title: String?,
        action: suspend () -> T,
    ): T {
        val project = intellijProject?.takeUnless { it.isDisposed }
        return if (project != null && title != null) {
            withBackgroundProgress(project, title, cancellable = true) { action() }
        } else {
            action()
        }
    }

    private fun cancelMaterializationJobs() {
        val jobs = synchronized(materializationJobs) { materializationJobs.toList() }
        jobs.forEach(Job::cancel)
    }

    companion object {
        private const val REMOTE_SEARCH_DEBOUNCE_MS = 750L
        private const val MIN_REMOTE_SEARCH_QUERY_LENGTH = 3
        private const val SEARCH_MATCH_BATCH_SIZE = 50

        private fun resolveWorkspaceRoot(project: Project): Path =
            project.basePath?.let(Path::of)
                ?: project.projectFilePath?.let(Path::of)?.parent
                ?: Path.of(System.getProperty("user.dir")).toAbsolutePath()
    }
}

internal class OpenLogEditorProtectionTracker(
    private val workspaceRoot: Path,
    private val coroutineScope: CoroutineScope,
    private val protectLog: (String) -> AutoCloseable,
    private val validateLogPath: (Path) -> String? = { path -> managedLifecycleLogId(workspaceRoot, path) },
) : Disposable {
    private val lock = Any()
    private val entries = mutableMapOf<Any, EditorProtectionEntry>()
    private val lexicalWorkspaceRoot = normalizeEditorPath(workspaceRoot.toString())
    private var generation = 0L
    private var disposed = false

    fun fileOpened(fileKey: Any, rawPath: String) {
        val logId = lexicalManagedLifecycleLogId(lexicalWorkspaceRoot, rawPath) ?: return
        val entry = synchronized(lock) {
            if (disposed || fileKey in entries) return
            generation += 1
            EditorProtectionEntry(generation, logId, protectLog(logId)).also { entries[fileKey] = it }
        }
        coroutineScope.launch(Dispatchers.IO) {
            val validatedLogId = runCatching {
                validateLogPath(Path.of(rawPath).toAbsolutePath().normalize())
            }.getOrNull()
            if (validatedLogId == entry.logId) return@launch
            val protection = synchronized(lock) {
                val current = entries[fileKey]
                if (disposed || current?.generation != entry.generation) return@synchronized null
                entries.remove(fileKey)?.protection
            }
            protection?.close()
        }
    }

    fun fileClosed(fileKey: Any) {
        synchronized(lock) { entries.remove(fileKey) }?.protection?.close()
    }

    override fun dispose() {
        val protections = synchronized(lock) {
            if (disposed) return
            disposed = true
            generation += 1
            entries.values.map(EditorProtectionEntry::protection).also { entries.clear() }
        }
        protections.forEach(AutoCloseable::close)
    }
}

internal fun lexicalManagedLifecycleLogId(workspaceRoot: String, rawPath: String): String? {
    val root = normalizeEditorPath(workspaceRoot).trimEnd('/')
    val path = normalizeEditorPath(rawPath)
    val apexlogsRoot = "$root/apexlogs"
    val ignoreCase = java.io.File.separatorChar == '\\'
    if (!path.startsWith(apexlogsRoot, ignoreCase) || path.length <= apexlogsRoot.length) return null
    if (path[apexlogsRoot.length] != '/') return null
    val segments = path.substring(apexlogsRoot.length + 1).split('/')
    if (segments.any { it.isEmpty() || it == "." || it == ".." }) return null
    val name = segments.lastOrNull().orEmpty()
    if (segments.size == 1) return EDITOR_LEGACY_LOG.matchEntire(name)?.groupValues?.get(1)
    if (
        segments.size == 5 &&
        segments[0].equals("orgs", ignoreCase) &&
        segments[2].equals("logs", ignoreCase) &&
        EDITOR_LOG_DAY.matches(segments[3])
    ) {
        return EDITOR_CANONICAL_LOG.matchEntire(name)?.groupValues?.get(1)
    }
    return null
}

private fun normalizeEditorPath(path: String): String = path.replace('\\', '/')

private data class EditorProtectionEntry(
    val generation: Long,
    val logId: String,
    val protection: AutoCloseable,
)

private val EDITOR_LOG_DAY = Regex("^(unknown-date|\\d{4}-\\d{2}-\\d{2})$")
private val EDITOR_CANONICAL_LOG = Regex("^(07L[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?)\\.log$")
private val EDITOR_LEGACY_LOG = Regex("^.+_(07L[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?)\\.log$")

private data class MaterializationKey(val username: String, val logId: String)

private data class TriageKey(val username: String, val logId: String)

private data class RetentionEpoch(val catalogGeneration: Long, val retentionGeneration: Long)

private data class CatalogOperationStart(
    val catalogGeneration: Long,
    val username: String,
    val cursor: LogCursor?,
    val logs: List<LogListRow>,
)

private data class SearchEpoch(
    val searchGeneration: Long,
    val catalogGeneration: Long,
)

private data class SearchStart(
    val epoch: SearchEpoch,
    val username: String,
    val viewOptions: LogViewOptions,
)

private data class SearchCatalogSnapshot(
    val logs: List<LogListRow>,
    val cursor: LogCursor?,
    val checkpoint: ProgressiveSearchCheckpoint?,
)

private data class SharedMaterialization(
    val deferred: Deferred<LocalLogFile>,
    var consumers: Int,
)

private data class MaterializationBatchResult(
    val attempted: Int = 0,
    val failedLogIds: List<String> = emptyList(),
    val existingCount: Int = 0,
    val materializedCount: Int = 0,
    val downloadedCount: Int = 0,
) {
    operator fun plus(other: MaterializationBatchResult): MaterializationBatchResult =
        MaterializationBatchResult(
            attempted = attempted + other.attempted,
            failedLogIds = failedLogIds + other.failedLogIds,
            existingCount = existingCount + other.existingCount,
            materializedCount = materializedCount + other.materializedCount,
            downloadedCount = downloadedCount + other.downloadedCount,
        )
}

private data class MaterializationOutcome(
    val logId: String,
    val file: LocalLogFile? = null,
    val failed: Boolean = false,
)

private fun List<MaterializationOutcome>.toBatchResult(): MaterializationBatchResult =
    MaterializationBatchResult(
        attempted = size,
        failedLogIds = filter(MaterializationOutcome::failed).map(MaterializationOutcome::logId),
        existingCount = count { !it.failed && it.file?.source != "remote" && it.file?.persistence != "written" },
        materializedCount = count { !it.failed && it.file?.source != "remote" && it.file?.persistence == "written" },
        downloadedCount = count { !it.failed && it.file?.source == "remote" },
    )

private data class ProgressiveSearchCheckpoint(
    val username: String,
    val query: String,
    val viewOptions: LogViewOptions,
    val catalogGeneration: Long,
    val logs: List<LogListRow>,
    val cursor: LogCursor?,
    val pagesExamined: Int,
    val bodiesProcessed: Int,
    val failedLogIds: Set<String>,
)

private data class LocalTriageOutcome(
    val logId: String,
    val attempted: Boolean,
    val failed: Boolean = false,
)
