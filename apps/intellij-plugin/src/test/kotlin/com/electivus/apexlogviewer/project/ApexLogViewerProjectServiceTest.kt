package com.electivus.apexlogviewer.project

import com.electivus.apexlogviewer.runtime.HttpResponse
import com.electivus.apexlogviewer.runtime.LogListRow
import com.electivus.apexlogviewer.runtime.ProcessResponse
import com.electivus.apexlogviewer.runtime.RuntimeDependencies
import com.electivus.apexlogviewer.runtime.RuntimeHttp
import com.electivus.apexlogviewer.runtime.RuntimeProcess
import com.electivus.apexlogviewer.runtime.supportsSecurePurgeDeletion
import com.electivus.apexlogviewer.ui.ApexLogsTableModel
import com.electivus.apexlogviewer.ui.logSortFieldForColumn
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.FileTime
import java.util.Comparator
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import junit.framework.TestCase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withContext
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicBoolean
import javax.swing.RowSorter
import javax.swing.SortOrder
import javax.swing.table.TableRowSorter

class ApexLogViewerProjectServiceTest : TestCase() {
    fun testEditorProtectionIsImmediateWhilePhysicalValidationRunsOffTheCallbackThread() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-project-editor-protection-")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val validationStarted = CompletableDeferred<Thread>()
        val releaseValidation = CountDownLatch(1)
        val activeProtections = AtomicInteger()
        val callbackThread = Thread.currentThread()
        val tracker = OpenLogEditorProtectionTracker(
            workspaceRoot = workspaceRoot,
            coroutineScope = scope,
            protectLog = {
                activeProtections.incrementAndGet()
                AutoCloseable { activeProtections.decrementAndGet() }
            },
            validateLogPath = {
                validationStarted.complete(Thread.currentThread())
                check(releaseValidation.await(5, TimeUnit.SECONDS)) { "Timed out releasing physical validation" }
                null
            },
        )
        val fileKey = Any()
        try {
            tracker.fileOpened(
                fileKey,
                workspaceRoot.resolve(
                    "apexlogs/orgs/demo@example.com/logs/2026-08-11/07L000000000091AAA.log",
                ).toString(),
            )

            assertEquals(1, activeProtections.get())
            assertNotSame(callbackThread, withTimeout(5_000) { validationStarted.await() })
            assertEquals("the provisional lease must remain while validation is blocked", 1, activeProtections.get())
            releaseValidation.countDown()
            withTimeout(5_000) {
                while (activeProtections.get() != 0) delay(10)
            }
        } finally {
            releaseValidation.countDown()
            tracker.dispose()
            scope.cancel()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testLateEditorValidationCannotReleaseAReopenedGenerationAndDisposeClosesIt() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-project-editor-generation-")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val logId = "07L000000000092AAA"
        val path = workspaceRoot.resolve("apexlogs/orgs/demo@example.com/logs/2026-08-11/$logId.log")
        val firstValidationStarted = CompletableDeferred<Unit>()
        val releaseFirstValidation = CountDownLatch(1)
        val validations = AtomicInteger()
        val activeProtections = AtomicInteger()
        val tracker = OpenLogEditorProtectionTracker(
            workspaceRoot = workspaceRoot,
            coroutineScope = scope,
            protectLog = {
                activeProtections.incrementAndGet()
                AutoCloseable { activeProtections.decrementAndGet() }
            },
            validateLogPath = {
                if (validations.incrementAndGet() == 1) {
                    firstValidationStarted.complete(Unit)
                    check(releaseFirstValidation.await(5, TimeUnit.SECONDS)) { "Timed out releasing stale validation" }
                    null
                } else {
                    logId
                }
            },
        )
        val fileKey = Any()
        try {
            tracker.fileOpened(fileKey, path.toString())
            withTimeout(5_000) { firstValidationStarted.await() }
            tracker.fileClosed(fileKey)
            tracker.fileOpened(fileKey, path.toString())
            withTimeout(5_000) {
                while (validations.get() < 2) delay(10)
            }
            assertEquals(1, activeProtections.get())

            releaseFirstValidation.countDown()
            delay(100)
            assertEquals("stale validation released the reopened generation", 1, activeProtections.get())

            tracker.dispose()
            assertEquals(0, activeProtections.get())
        } finally {
            releaseFirstValidation.countDown()
            tracker.dispose()
            scope.cancel()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testLogTableSortColumnsMatchTheVisibleHeaders() {
        assertEquals(LogSortField.START_TIME, logSortFieldForColumn(0))
        assertEquals(LogSortField.OPERATION, logSortFieldForColumn(1))
        assertNull(logSortFieldForColumn(2))
        assertEquals(LogSortField.STATUS, logSortFieldForColumn(3))
        assertEquals(LogSortField.SIZE, logSortFieldForColumn(4))
        assertEquals(LogSortField.LOG_ID, logSortFieldForColumn(5))
        assertNull(logSortFieldForColumn(6))
    }

    fun testLengthColumnUsesNumericRowSorting() {
        val model = ApexLogsTableModel()
        model.replaceAll(
            listOf(
                LogListRow(id = "long", logLength = 100),
                LogListRow(id = "short", logLength = 20),
            ),
            SearchProjectState(),
            emptyMap(),
        )
        val sorter = TableRowSorter(model)
        sorter.sortKeys = listOf(RowSorter.SortKey(4, SortOrder.ASCENDING))
        sorter.sort()

        assertEquals(Int::class.javaObjectType, model.getColumnClass(4))
        assertEquals(
            listOf("short", "long"),
            (0 until model.rowCount).map { viewRow ->
                model.rowAt(sorter.convertRowIndexToModel(viewRow))!!.id
            },
        )
    }

    fun testLoadedPageAcquisitionTriagesErrorsAndCoalescesConcurrentViewerRequests() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-project-background-acquisition-")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val logId = "07L000000000091AAA"
        val bodyGate = CompletableDeferred<Unit>()
        val bodyRequests = AtomicInteger()
        val viewerCompletions = AtomicInteger()
        val service = ApexLogViewerProjectService(
            workspaceRoot,
            scope,
            RuntimeDependencies(
                process = RuntimeProcess { request ->
                    if (request.arguments.getOrNull(1) == "list") {
                        ProcessResponse(
                            0,
                            """{"status":0,"result":{"nonScratchOrgs":[{"username":"default@example.com","isDefaultUsername":true}]}}""",
                            "",
                        )
                    } else {
                        ProcessResponse(
                            0,
                            """{"status":0,"result":{"username":"default@example.com","instanceUrl":"https://example.my.salesforce.com","accessToken":"token","apiVersion":"63.0"}}""",
                            "",
                        )
                    }
                },
                http = RuntimeHttp { request ->
                    if (request.url.endsWith("/$logId/Body")) {
                        bodyRequests.incrementAndGet()
                        bodyGate.await()
                        HttpResponse(200, emptyMap(), "12:00:00.000 (1)|FATAL_ERROR|Null pointer\n")
                    } else {
                        HttpResponse(
                            200,
                            emptyMap(),
                            """{"records":[{"Id":"$logId","StartTime":"2026-08-10T18:00:00.000Z","Status":"Success"}]}""",
                        )
                    }
                },
            ),
            pageSize = 100,
            backgroundAcquisition = true,
        )
        try {
            service.refresh()
            val acquiring = withTimeout(5_000) { service.state.first { it.isAcquiringBodies } }
            val row = acquiring.logs.single()
            service.materializeLog(row) { result ->
                assertTrue(result.isSuccess)
                viewerCompletions.incrementAndGet()
            }
            service.materializeLog(row) { result ->
                assertTrue(result.isSuccess)
                viewerCompletions.incrementAndGet()
            }

            bodyGate.complete(Unit)

            val acquired = withTimeout(5_000) {
                service.state.first { !it.isAcquiringBodies && it.acquisitionProcessed == 1 }
            }
            withTimeout(5_000) {
                while (viewerCompletions.get() < 2) kotlinx.coroutines.yield()
            }
            assertEquals(1, bodyRequests.get())
            assertTrue(acquired.triageByLogId.getValue(logId).hasErrors)

            service.setViewOptions(acquired.viewOptions.copy(errorsOnly = true))
            assertEquals(listOf(logId), service.state.value.logs.map { it.id })
        } finally {
            bodyGate.complete(Unit)
            service.dispose()
            scope.cancel()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testViewOptionsComposeOperationStatusErrorsAndStableSorting() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-project-view-options-")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val service = ApexLogViewerProjectService(
            workspaceRoot,
            scope,
            RuntimeDependencies(
                process = RuntimeProcess { request ->
                    if (request.arguments.getOrNull(1) == "list") {
                        ProcessResponse(
                            0,
                            """{"status":0,"result":{"nonScratchOrgs":[{"username":"default@example.com","isDefaultUsername":true}]}}""",
                            "",
                        )
                    } else {
                        ProcessResponse(
                            0,
                            """{"status":0,"result":{"username":"default@example.com","instanceUrl":"https://example.my.salesforce.com","accessToken":"token","apiVersion":"63.0"}}""",
                            "",
                        )
                    }
                },
                http = RuntimeHttp {
                    HttpResponse(
                        200,
                        emptyMap(),
                        """{"records":[
                            {"Id":"07L000000000083AAA","StartTime":"2026-08-10T18:03:00.000Z","Operation":"Execute Anonymous","Status":"Success","LogUser":{"Name":"Demo User"}},
                            {"Id":"07L000000000081AAA","StartTime":"2026-08-10T18:01:00.000Z","Operation":"Execute Anonymous","Status":"Failed","LogUser":{"Name":"Demo User"}},
                            {"Id":"07L000000000082AAA","StartTime":"2026-08-10T18:02:00.000Z","Operation":"API","Status":"Failed","LogUser":{"Name":"Other User"}}
                        ]}""".trimIndent(),
                    )
                },
            ),
            pageSize = 100,
        )
        try {
            service.refresh()
            withTimeout(5_000) { service.state.first { !it.isRefreshing && it.logs.size == 3 } }

            service.setViewOptions(
                LogViewOptions(
                    user = "Demo User",
                    operation = "Execute Anonymous",
                    sortField = LogSortField.LOG_ID,
                    sortDirection = LogSortDirection.ASCENDING,
                ),
            )
            assertEquals(
                listOf("07L000000000081AAA", "07L000000000083AAA"),
                service.state.value.logs.map { it.id },
            )

            service.setViewOptions(service.state.value.viewOptions.copy(errorsOnly = true))
            assertEquals(listOf("07L000000000081AAA"), service.state.value.logs.map { it.id })
            assertEquals(listOf("API", "Execute Anonymous"), service.state.value.availableOperations)
            assertEquals(listOf("Failed", "Success"), service.state.value.availableStatuses)
            assertEquals(listOf("Demo User", "Other User"), service.state.value.availableUsers)
        } finally {
            service.dispose()
            scope.cancel()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testRemoteSearchFailurePreservesCompletedMatchesAndTheRetryCheckpoint() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-project-search-failure-")
        val matchingId = "07L000000000071AAA"
        val localBody = workspaceRoot.resolve(
            "apexlogs/orgs/default@example.com/logs/2026-08-10/$matchingId.log",
        )
        Files.createDirectories(localBody.parent)
        Files.writeString(localBody, "prefix needle suffix\n")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        var catalogRequestCount = 0
        val service = ApexLogViewerProjectService(
            workspaceRoot,
            scope,
            RuntimeDependencies(
                process = RuntimeProcess { request ->
                    if (request.arguments.getOrNull(1) == "list") {
                        ProcessResponse(
                            0,
                            """{"status":0,"result":{"nonScratchOrgs":[{"username":"default@example.com","isDefaultUsername":true}]}}""",
                            "",
                        )
                    } else {
                        ProcessResponse(
                            0,
                            """{"status":0,"result":{"username":"default@example.com","instanceUrl":"https://example.my.salesforce.com","accessToken":"token","apiVersion":"63.0"}}""",
                            "",
                        )
                    }
                },
                http = RuntimeHttp {
                    catalogRequestCount += 1
                    if (catalogRequestCount == 1) {
                        HttpResponse(
                            200,
                            emptyMap(),
                            """{"records":[{"Id":"$matchingId","StartTime":"2026-08-10T18:00:00.000Z","Status":"Success"}]}""",
                        )
                    } else if (catalogRequestCount == 2) {
                        HttpResponse(503, emptyMap(), "temporarily unavailable")
                    } else {
                        HttpResponse(200, emptyMap(), """{"records":[]}""")
                    }
                },
            ),
            pageSize = 1,
        )
        try {
            service.refresh()
            withTimeout(5_000) { service.state.first { !it.isRefreshing && it.logs.size == 1 } }

            service.setSearchQuery("needle")

            val failed = withTimeout(5_000) { service.state.first { it.failure?.code == "remote-acquisition" } }
            assertEquals(listOf(matchingId), failed.logs.map { it.id })
            assertEquals(listOf(matchingId), failed.search.matches.map { it.logId })
            assertEquals(1, failed.search.pagesExamined)
            assertFalse(failed.search.isSearching)
            assertFalse(failed.search.isRemoteSearching)
            assertFalse(failed.search.canContinue)

            service.retrySearch()
            val recovered = withTimeout(5_000) {
                service.state.first { it.failure == null && it.search.snapshotExhausted && !it.search.isSearching }
            }
            assertEquals(listOf(matchingId), recovered.search.matches.map { it.logId })
            assertEquals(3, catalogRequestCount)
        } finally {
            service.dispose()
            scope.cancel()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testShortErrorsOnlySearchStaysLocalAndCannotContinueRemotePagination() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-project-short-search-")
        val logId = "07L000000000095AAA"
        val localBody = workspaceRoot.resolve("apexlogs/orgs/default@example.com/logs/2026-08-10/$logId.log")
        Files.createDirectories(localBody.parent)
        Files.writeString(localBody, "12:00:00.000 (1)|FATAL_ERROR|needle\n")
        val bodyRequests = AtomicInteger()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val service = ApexLogViewerProjectService(
            workspaceRoot,
            scope,
            RuntimeDependencies(
                process = RuntimeProcess { request ->
                    if (request.arguments.getOrNull(1) == "list") {
                        ProcessResponse(0, """{"status":0,"result":{"nonScratchOrgs":[{"username":"default@example.com","isDefaultUsername":true}]}}""", "")
                    } else {
                        ProcessResponse(0, """{"status":0,"result":{"username":"default@example.com","instanceUrl":"https://example.my.salesforce.com","accessToken":"token","apiVersion":"63.0"}}""", "")
                    }
                },
                http = RuntimeHttp { request ->
                    if (request.url.endsWith("/Body")) {
                        bodyRequests.incrementAndGet()
                        HttpResponse(200, emptyMap(), "remote body")
                    } else {
                        HttpResponse(
                            200,
                            emptyMap(),
                            """{"records":[{"Id":"$logId","StartTime":"2026-08-10T18:00:00.000Z","Status":"Success"}]}""",
                        )
                    }
                },
            ),
            pageSize = 1,
        )
        try {
            service.refresh()
            withTimeout(5_000) { service.state.first { !it.isRefreshing && it.logs.size == 1 } }
            service.setViewOptions(service.state.value.viewOptions.copy(errorsOnly = true))
            service.setSearchQuery("n")

            val local = withTimeout(5_000) {
                service.state.first { it.search.query == "n" && !it.search.isSearching }
            }
            assertEquals(listOf(logId), local.logs.map { it.id })
            assertFalse(local.search.canContinue)
            assertEquals(0, bodyRequests.get())
        } finally {
            service.dispose()
            scope.cancel()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testSearchCancellationStopsAnUnsharedBodyAcquisition() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-project-search-cancel-")
        val logId = "07L000000000094AAA"
        val bodyStarted = CompletableDeferred<Unit>()
        val bodyCancelled = CompletableDeferred<Unit>()
        val bodyGate = CompletableDeferred<Unit>()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val service = ApexLogViewerProjectService(
            workspaceRoot,
            scope,
            RuntimeDependencies(
                process = RuntimeProcess { request ->
                    if (request.arguments.getOrNull(1) == "list") {
                        ProcessResponse(0, """{"status":0,"result":{"nonScratchOrgs":[{"username":"default@example.com","isDefaultUsername":true}]}}""", "")
                    } else {
                        ProcessResponse(0, """{"status":0,"result":{"username":"default@example.com","instanceUrl":"https://example.my.salesforce.com","accessToken":"token","apiVersion":"63.0"}}""", "")
                    }
                },
                http = RuntimeHttp { request ->
                    if (request.url.endsWith("/Body")) {
                        bodyStarted.complete(Unit)
                        try {
                            bodyGate.await()
                            HttpResponse(200, emptyMap(), "needle")
                        } finally {
                            bodyCancelled.complete(Unit)
                        }
                    } else {
                        HttpResponse(200, emptyMap(), """{"records":[{"Id":"$logId","StartTime":"2026-08-10T18:00:00.000Z","Status":"Success"}]}""")
                    }
                },
            ),
        )
        try {
            service.refresh()
            withTimeout(5_000) { service.state.first { !it.isRefreshing && it.logs.size == 1 } }
            service.setSearchQuery("needle")
            withTimeout(5_000) { bodyStarted.await() }

            service.setSearchQuery("")

            withTimeout(5_000) { bodyCancelled.await() }
            assertEquals("", service.state.value.search.query)
        } finally {
            bodyGate.complete(Unit)
            service.dispose()
            scope.cancel()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testFailedBodyIsDistinctFromPendingAndRetryCanRecoverIt() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-project-body-retry-")
        val logId = "07L000000000093AAA"
        val bodyRequests = AtomicInteger()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val service = ApexLogViewerProjectService(
            workspaceRoot,
            scope,
            RuntimeDependencies(
                process = RuntimeProcess { request ->
                    if (request.arguments.getOrNull(1) == "list") {
                        ProcessResponse(0, """{"status":0,"result":{"nonScratchOrgs":[{"username":"default@example.com","isDefaultUsername":true}]}}""", "")
                    } else {
                        ProcessResponse(0, """{"status":0,"result":{"username":"default@example.com","instanceUrl":"https://example.my.salesforce.com","accessToken":"token","apiVersion":"63.0"}}""", "")
                    }
                },
                http = RuntimeHttp { request ->
                    if (request.url.endsWith("/Body")) {
                        if (bodyRequests.incrementAndGet() == 1) HttpResponse(503, emptyMap(), "unavailable") else {
                            HttpResponse(200, emptyMap(), "prefix needle suffix")
                        }
                    } else {
                        HttpResponse(200, emptyMap(), """{"records":[{"Id":"$logId","StartTime":"2026-08-10T18:00:00.000Z","Status":"Success"}]}""")
                    }
                },
            ),
            pageSize = 100,
        )
        try {
            service.refresh()
            withTimeout(5_000) { service.state.first { !it.isRefreshing && it.logs.size == 1 } }
            service.setSearchQuery("needle")

            val failed = withTimeout(5_000) { service.state.first { it.search.failedLogIds == listOf(logId) } }
            assertEquals(emptyList<String>(), failed.search.pendingLogIds)
            assertEquals(1, failed.search.partialFailureCount)

            service.retrySearch()
            val recovered = withTimeout(5_000) {
                service.state.first { it.search.matches.any { match -> match.logId == logId } && !it.search.isSearching }
            }
            assertEquals(emptyList<String>(), recovered.search.failedLogIds)
            assertNull(recovered.failure)
            assertEquals(2, bodyRequests.get())
        } finally {
            service.dispose()
            scope.cancel()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testNonDefaultSearchUsesSortAwarePagingAndStopsAtFiftyMatches() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-project-search-order-")
        val initialPage = (100 downTo 51).joinToString(",") { index ->
            val id = "07L${index.toString().padStart(12, '0')}AAA"
            """{"Id":"$id","StartTime":"2026-08-10T18:00:00.000Z","Status":"needle"}"""
        }
        val sortedPage = (1..50).joinToString(",") { index ->
            val id = "07L${index.toString().padStart(12, '0')}AAA"
            """{"Id":"$id","StartTime":"2026-08-10T17:59:00.000Z","Status":"needle"}"""
        }
        val catalogRequests = AtomicInteger()
        var firstSnapshotWatermark: String? = null
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val service = ApexLogViewerProjectService(
            workspaceRoot,
            scope,
            RuntimeDependencies(
                process = RuntimeProcess { request ->
                    if (request.arguments.getOrNull(1) == "list") {
                        ProcessResponse(0, """{"status":0,"result":{"nonScratchOrgs":[{"username":"default@example.com","isDefaultUsername":true}]}}""", "")
                    } else {
                        ProcessResponse(0, """{"status":0,"result":{"username":"default@example.com","instanceUrl":"https://example.my.salesforce.com","accessToken":"token","apiVersion":"63.0"}}""", "")
                    }
                },
                http = RuntimeHttp { request ->
                    val requestNumber = catalogRequests.incrementAndGet()
                    when (requestNumber) {
                        1 -> HttpResponse(200, emptyMap(), """{"records":[$initialPage]}""")
                        2 -> {
                            val decoded = java.net.URLDecoder.decode(request.url, java.nio.charset.StandardCharsets.UTF_8)
                            assertTrue(decoded.contains("ORDER BY Id ASC"))
                            firstSnapshotWatermark = Regex("SystemModstamp <= ([^ ]+)")
                                .find(decoded)?.groupValues?.get(1)
                            assertNotNull(firstSnapshotWatermark)
                            HttpResponse(200, emptyMap(), """{"records":[$sortedPage]}""")
                        }
                        3 -> {
                            val decoded = java.net.URLDecoder.decode(request.url, java.nio.charset.StandardCharsets.UTF_8)
                            assertTrue(decoded.contains("Id > '07L000000000050AAA'"))
                            assertEquals(
                                firstSnapshotWatermark,
                                Regex("SystemModstamp <= ([^ ]+)").find(decoded)?.groupValues?.get(1),
                            )
                            HttpResponse(200, emptyMap(), """{"records":[$initialPage]}""")
                        }
                        else -> throw AssertionError("Search fetched beyond its 50-match batch")
                    }
                },
            ),
            pageSize = 50,
        )
        try {
            service.refresh()
            withTimeout(5_000) { service.state.first { !it.isRefreshing && it.logs.size == 50 } }
            service.setViewOptions(
                service.state.value.viewOptions.copy(
                    sortField = LogSortField.LOG_ID,
                    sortDirection = LogSortDirection.ASCENDING,
                ),
            )
            service.setSearchQuery("needle")

            val ordered = withTimeout(5_000) {
                service.state.first {
                    it.search.pagesExamined == 2 && it.search.matches.size == 50 && !it.search.isSearching
                }
            }
            assertEquals("07L000000000001AAA", ordered.search.matches.first().logId)
            assertFalse(ordered.search.snapshotExhausted)
            assertTrue(ordered.search.canContinue)
            assertEquals(2, catalogRequests.get())

            service.continueSearch()
            val continued = withTimeout(5_000) {
                service.state.first {
                    it.search.matchOffset == 50 && it.search.pagesExamined == 3 &&
                        it.search.matches.size == 50 && !it.search.isSearching
                }
            }
            assertEquals("07L000000000051AAA", continued.search.matches.first().logId)
            assertEquals(3, catalogRequests.get())
        } finally {
            service.dispose()
            scope.cancel()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testNonDefaultRetryResumesTheFailedPageAndRecoversCheckpointBodiesFirst() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-project-search-resume-")
        val initialId = "07L000000000099AAA"
        val matchingId = "07L000000000096AAA"
        val catalogRequests = AtomicInteger()
        val bodyRequests = AtomicInteger()
        val catalogQueries = java.util.Collections.synchronizedList(mutableListOf<String>())
        val events = java.util.Collections.synchronizedList(mutableListOf<String>())
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val service = ApexLogViewerProjectService(
            workspaceRoot,
            scope,
            RuntimeDependencies(
                process = RuntimeProcess { request ->
                    if (request.arguments.getOrNull(1) == "list") {
                        ProcessResponse(0, """{"status":0,"result":{"nonScratchOrgs":[{"username":"default@example.com","isDefaultUsername":true}]}}""", "")
                    } else {
                        ProcessResponse(0, """{"status":0,"result":{"username":"default@example.com","instanceUrl":"https://example.my.salesforce.com","accessToken":"token","apiVersion":"63.0"}}""", "")
                    }
                },
                http = RuntimeHttp { request ->
                    if (request.url.endsWith("/Body")) {
                        val requestNumber = bodyRequests.incrementAndGet()
                        events += "body-$requestNumber"
                        if (requestNumber == 1) {
                            HttpResponse(503, emptyMap(), "temporarily unavailable")
                        } else {
                            HttpResponse(200, emptyMap(), "prefix needle suffix")
                        }
                    } else {
                        val requestNumber = catalogRequests.incrementAndGet()
                        val decoded = java.net.URLDecoder.decode(
                            request.url,
                            java.nio.charset.StandardCharsets.UTF_8,
                        )
                        catalogQueries += decoded
                        events += "catalog-$requestNumber"
                        when (requestNumber) {
                            1 -> HttpResponse(
                                200,
                                emptyMap(),
                                """{"records":[{"Id":"$initialId","StartTime":"2026-08-10T18:00:00.000Z","Status":"Success"}]}""",
                            )
                            2 -> HttpResponse(
                                200,
                                emptyMap(),
                                """{"records":[{"Id":"$matchingId","StartTime":"2026-08-10T17:59:00.000Z","Status":"Success"}]}""",
                            )
                            3 -> HttpResponse(503, emptyMap(), "temporarily unavailable")
                            4 -> HttpResponse(200, emptyMap(), """{"records":[]}""")
                            else -> throw AssertionError("Retry fetched an unexpected catalog page")
                        }
                    }
                },
            ),
            pageSize = 1,
        )
        try {
            service.refresh()
            withTimeout(5_000) { service.state.first { !it.isRefreshing && it.logs.size == 1 } }
            service.setViewOptions(
                service.state.value.viewOptions.copy(
                    sortField = LogSortField.LOG_ID,
                    sortDirection = LogSortDirection.ASCENDING,
                ),
            )
            service.setSearchQuery("needle")

            val failed = withTimeout(5_000) {
                service.state.first { it.failure?.code == "remote-acquisition" }
            }
            assertEquals(listOf(matchingId), failed.search.failedLogIds)
            assertEquals(2, failed.search.pagesExamined)
            assertEquals(listOf("catalog-1", "catalog-2", "body-1", "catalog-3"), events.toList())

            service.retrySearch()
            val recovered = withTimeout(5_000) {
                service.state.first {
                    it.failure == null && it.search.snapshotExhausted && !it.search.isSearching &&
                        it.search.matches.any { match -> match.logId == matchingId }
                }
            }
            assertEquals(listOf(matchingId), recovered.search.matches.map { it.logId })
            assertEquals(recovered.search.matches.map { it.logId }.distinct(), recovered.search.matches.map { it.logId })
            assertEquals(emptyList<String>(), recovered.search.failedLogIds)
            assertEquals(4, catalogRequests.get())
            assertEquals(2, bodyRequests.get())
            assertEquals(listOf("body-2", "catalog-4"), events.takeLast(2))
            assertTrue(catalogQueries[2].contains("Id > '$matchingId'"))
            assertTrue(catalogQueries[3].contains("Id > '$matchingId'"))
            val watermark = Regex("SystemModstamp <= ([^ ]+)")
            assertEquals(
                watermark.find(catalogQueries[2])?.groupValues?.get(1),
                watermark.find(catalogQueries[3])?.groupValues?.get(1),
            )
            assertNotNull(watermark.find(catalogQueries[3]))
        } finally {
            service.dispose()
            scope.cancel()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testContinueSearchPublishesTheNextBatchOfDistinctMatches() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-project-continue-search-")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val records = (1..60).joinToString(",") { index ->
            val id = "07L${index.toString().padStart(12, '0')}AAA"
            """{"Id":"$id","StartTime":"2026-08-10T18:00:00.000Z","Status":"needle"}"""
        }
        val service = ApexLogViewerProjectService(
            workspaceRoot,
            scope,
            RuntimeDependencies(
                process = RuntimeProcess { request ->
                    if (request.arguments.getOrNull(1) == "list") {
                        ProcessResponse(0, """{"status":0,"result":{"nonScratchOrgs":[{"username":"default@example.com","isDefaultUsername":true}]}}""", "")
                    } else {
                        ProcessResponse(0, """{"status":0,"result":{"username":"default@example.com","instanceUrl":"https://example.my.salesforce.com","accessToken":"token","apiVersion":"63.0"}}""", "")
                    }
                },
                http = RuntimeHttp { HttpResponse(200, emptyMap(), """{"records":[$records]}""") },
            ),
            pageSize = 100,
        )
        try {
            service.refresh()
            withTimeout(5_000) { service.state.first { !it.isRefreshing && it.logs.size == 60 } }
            service.setSearchQuery("needle")
            val firstBatch = withTimeout(5_000) { service.state.first { it.search.matches.size == 50 } }
            assertTrue(firstBatch.search.canContinue)
            assertEquals(0, firstBatch.search.matchOffset)

            service.continueSearch()

            val secondBatch = withTimeout(5_000) {
                service.state.first { it.search.matchOffset == 50 && it.search.matches.size == 10 && !it.search.isSearching }
            }
            assertFalse(secondBatch.search.canContinue)
            assertEquals(60, secondBatch.search.totalMatches)
            assertEquals("07L000000000010AAA", secondBatch.search.matches.first().logId)
        } finally {
            service.dispose()
            scope.cancel()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testLoadMoreContinuesTheCatalogCursorAndKeepsTheExistingRows() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-project-load-more-")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        var queryCount = 0
        val service = ApexLogViewerProjectService(
            workspaceRoot,
            scope,
            RuntimeDependencies(
                process = RuntimeProcess { request ->
                    when (request.arguments.firstOrNull()) {
                        "org" -> if (request.arguments.getOrNull(1) == "list") {
                            ProcessResponse(0, """{"status":0,"result":{"nonScratchOrgs":[{"username":"default@example.com","isDefaultUsername":true}]}}""", "")
                        } else {
                            ProcessResponse(0, """{"status":0,"result":{"username":"default@example.com","instanceUrl":"https://example.my.salesforce.com","accessToken":"token","apiVersion":"63.0"}}""", "")
                        }
                        else -> error("unexpected process request: $request")
                    }
                },
                http = RuntimeHttp {
                    queryCount += 1
                    if (queryCount == 1) {
                        HttpResponse(200, emptyMap(), """{"records":[{"Id":"07L000000000061AAA","StartTime":"2026-08-10T18:00:00.000Z"},{"Id":"07L000000000060AAA","StartTime":"2026-08-10T17:59:00.000Z"}]}""")
                    } else {
                        HttpResponse(200, emptyMap(), """{"records":[{"Id":"07L000000000059AAA","StartTime":"2026-08-10T17:58:00.000Z"}]}""")
                    }
                },
            ),
            pageSize = 2,
        )
        try {
            service.refresh()
            val firstPage = withTimeout(5_000) { service.state.first { !it.isRefreshing && it.logs.size == 2 } }
            assertEquals("the stable catalog has another page", true, firstPage.hasMoreLogs)

            service.loadMore()

            val secondPage = withTimeout(5_000) { service.state.first { !it.isLoadingMore && it.logs.size == 3 } }
            assertEquals(
                listOf("07L000000000061AAA", "07L000000000060AAA", "07L000000000059AAA"),
                secondPage.logs.map { it.id },
            )
            assertFalse(secondPage.hasMoreLogs)
        } finally {
            service.dispose()
            scope.cancel()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testRemoteSearchExpandsCatalogPagesUntilTheStableSnapshotIsExhausted() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-project-search-pages-")
        val firstId = "07L000000000051AAA"
        val secondId = "07L000000000050AAA"
        val matchingId = "07L000000000049AAA"
        val requestedUrls = mutableListOf<String>()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val service = ApexLogViewerProjectService(
            workspaceRoot = workspaceRoot,
            coroutineScope = scope,
            dependencies = RuntimeDependencies(
                process = RuntimeProcess { request ->
                    when (request.arguments) {
                        listOf("org", "list", "--json") -> ProcessResponse(
                            0,
                            """{"status":0,"result":{"nonScratchOrgs":[{"username":"default@example.com","isDefaultUsername":true}]}}""",
                            "",
                        )
                        listOf("org", "display", "--target-org", "default@example.com", "--json") -> ProcessResponse(
                            0,
                            """{"status":0,"result":{"username":"default@example.com","instanceUrl":"https://example.my.salesforce.com","accessToken":"test-token","apiVersion":"63.0"}}""",
                            "",
                        )
                        else -> error("unexpected process request: $request")
                    }
                },
                http = RuntimeHttp { request ->
                    requestedUrls += request.url
                    when {
                        request.url.endsWith("/$matchingId/Body") -> HttpResponse(200, emptyMap(), "needle on second page")
                        request.url.endsWith("/Body") -> HttpResponse(200, emptyMap(), "no match")
                        request.url.contains("WHERE") || request.url.contains("%20WHERE%20") -> HttpResponse(
                            200,
                            emptyMap(),
                            """{"records":[{"Id":"$matchingId","StartTime":"2026-08-10T17:58:00.000Z","Status":"Success"}]}""",
                        )
                        else -> HttpResponse(
                            200,
                            emptyMap(),
                            """{"records":[{"Id":"$firstId","StartTime":"2026-08-10T18:00:00.000Z","Status":"Success"},{"Id":"$secondId","StartTime":"2026-08-10T17:59:00.000Z","Status":"Success"}]}""",
                        )
                    }
                },
            ),
            pageSize = 2,
        )
        try {
            service.refresh()
            withTimeout(5_000) { service.state.first { !it.isRefreshing && it.logs.size == 2 } }

            service.setSearchQuery("needle")

            val state = withTimeout(5_000) {
                service.state.first { it.search.matches.any { match -> match.logId == matchingId } }
            }
            assertEquals(2, state.search.pagesExamined)
            assertTrue(state.search.snapshotExhausted)
            assertTrue(requestedUrls.none { it.contains("needle", ignoreCase = true) })
        } finally {
            service.dispose()
            scope.cancel()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testEligibleSearchMaterializesPendingBodiesAfterTheDebounceWithoutSendingTheQuery() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-project-remote-search-")
        val logId = "07L000000000041AAA"
        val httpRequests = mutableListOf<String>()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val service = ApexLogViewerProjectService(
            workspaceRoot = workspaceRoot,
            coroutineScope = scope,
            dependencies = RuntimeDependencies(
                process = RuntimeProcess { request ->
                    when (request.arguments) {
                        listOf("org", "list", "--json") -> ProcessResponse(
                            0,
                            """{"status":0,"result":{"nonScratchOrgs":[{"username":"default@example.com","isDefaultUsername":true}]}}""",
                            "",
                        )
                        listOf("org", "display", "--target-org", "default@example.com", "--json") -> ProcessResponse(
                            0,
                            """{"status":0,"result":{"username":"default@example.com","instanceUrl":"https://example.my.salesforce.com","accessToken":"test-token","apiVersion":"63.0"}}""",
                            "",
                        )
                        else -> error("unexpected process request: $request")
                    }
                },
                http = RuntimeHttp { request ->
                    httpRequests += request.url
                    if (request.url.endsWith("/$logId/Body")) {
                        HttpResponse(200, emptyMap(), "prefix needle suffix\n")
                    } else {
                        HttpResponse(
                            200,
                            emptyMap(),
                            """{"records":[{"Id":"$logId","StartTime":"2026-08-10T18:00:00.000Z","Status":"Success"}]}""",
                        )
                    }
                },
            ),
        )
        try {
            service.refresh()
            withTimeout(5_000) { service.state.first { !it.isRefreshing && it.logs.size == 1 } }

            service.setSearchQuery("needle")
            val localState = withTimeout(5_000) {
                service.state.first { it.search.query == "needle" && it.search.pendingLogIds == listOf(logId) }
            }
            assertFalse(localState.search.isRemoteSearching)
            assertEquals(0, httpRequests.count { it.endsWith("/Body") })

            val remoteState = withTimeout(5_000) {
                service.state.first { it.search.matches.any { match -> match.logId == logId } }
            }
            assertFalse(remoteState.search.isRemoteSearching)
            assertEquals(emptyList<String>(), remoteState.search.pendingLogIds)
            assertTrue(httpRequests.single { it.endsWith("/Body") }.contains("needle", ignoreCase = true).not())
        } finally {
            service.dispose()
            scope.cancel()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testSearchQueryPublishesImmediateLocalMatchesAndPendingBodies() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-project-search-")
        val matchingId = "07L000000000021AAA"
        val pendingId = "07L000000000022AAA"
        val localBody = workspaceRoot.resolve(
            "apexlogs/orgs/default@example.com/logs/2026-08-10/$matchingId.log",
        )
        Files.createDirectories(localBody.parent)
        Files.writeString(localBody, "prefix NeEdLe suffix\n")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val service = ApexLogViewerProjectService(
            workspaceRoot = workspaceRoot,
            coroutineScope = scope,
            dependencies = RuntimeDependencies(
                process = RuntimeProcess { request ->
                    when (request.arguments) {
                        listOf("org", "list", "--json") -> ProcessResponse(
                            0,
                            """{"status":0,"result":{"nonScratchOrgs":[{"username":"default@example.com","isDefaultUsername":true}]}}""",
                            "",
                        )
                        listOf("org", "display", "--target-org", "default@example.com", "--json") -> ProcessResponse(
                            0,
                            """{"status":0,"result":{"username":"default@example.com","instanceUrl":"https://example.my.salesforce.com","accessToken":"test-token","apiVersion":"63.0"}}""",
                            "",
                        )
                        else -> error("unexpected process request: $request")
                    }
                },
                http = RuntimeHttp {
                    HttpResponse(
                        200,
                        emptyMap(),
                        """{"records":[{"Id":"$matchingId","StartTime":"2026-08-10T18:00:00.000Z","Status":"Success"},{"Id":"$pendingId","StartTime":"2026-08-10T18:01:00.000Z","Status":"Success"}]}""",
                    )
                },
            ),
        )
        try {
            service.refresh()
            withTimeout(5_000) { service.state.first { !it.isRefreshing && it.logs.size == 2 } }

            service.setSearchQuery("needle")

            val state = withTimeout(5_000) {
                service.state.first { it.search.query == "needle" && !it.search.isSearching }
            }
            assertEquals(listOf(pendingId, matchingId), state.logs.map { it.id })
            assertEquals(listOf(matchingId), state.search.matches.map { it.logId })
            assertEquals(listOf(pendingId), state.search.pendingLogIds)
        } finally {
            service.dispose()
            scope.cancel()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testRefreshPrefersTheDefaultOrgAndPublishesItsLogs() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-project-refresh-")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val service = ApexLogViewerProjectService(
            workspaceRoot = workspaceRoot,
            coroutineScope = scope,
            dependencies = RuntimeDependencies(
                process = RuntimeProcess { request ->
                    when (request.arguments) {
                        listOf("org", "list", "--json") -> ProcessResponse(
                            0,
                            """{"status":0,"result":{"nonScratchOrgs":[{"username":"other@example.com","alias":"Other"},{"username":"default@example.com","alias":"Default","isDefaultUsername":true}]}}""",
                            "",
                        )
                        listOf("org", "display", "--target-org", "default@example.com", "--json") -> ProcessResponse(
                            0,
                            """{"status":0,"result":{"username":"default@example.com","instanceUrl":"https://example.my.salesforce.com","accessToken":"test-token","apiVersion":"63.0"}}""",
                            "",
                        )
                        else -> error("unexpected process request: $request")
                    }
                },
                http = RuntimeHttp {
                    HttpResponse(
                        status = 200,
                        headers = emptyMap(),
                        body =
                            """{"records":[{"Id":"07L000000000001AAA","StartTime":"2026-08-10T18:00:00.000+0000","Operation":"/services/data","Status":"Success","LogLength":321}]}""",
                    )
                },
            ),
        )
        try {
            service.refresh()

            val state = withTimeout(5_000) {
                service.state.first { !it.isRefreshing && it.logs.isNotEmpty() }
            }
            assertEquals("default@example.com", state.selectedOrg)
            assertEquals(listOf("default@example.com", "other@example.com"), state.orgs.map { it.username })
            assertEquals(listOf("07L000000000001AAA"), state.logs.map { it.id })
            assertNull(state.failure)
        } finally {
            service.dispose()
            scope.cancel()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testOrgSelectionInvalidationIsAtomicAgainstValidatedAcquisitionCommit() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-project-org-acquisition-atomic-")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val acquisitionValidated = CompletableDeferred<Unit>()
        val releaseAcquisition = CountDownLatch(1)
        val firstLogId = "07L000000000181AAA"
        val secondLogId = "07L000000000182AAA"
        val service = ApexLogViewerProjectService(
            workspaceRoot,
            scope,
            RuntimeDependencies(
                process = twoOrgProcess(),
                http = RuntimeHttp { request ->
                    when {
                        request.url.endsWith("/Body") -> HttpResponse(
                            200,
                            emptyMap(),
                            "12:00:00.000 (1)|FATAL_ERROR|failure\n",
                        )
                        request.url.startsWith("https://first.example.com/") ->
                            HttpResponse(200, emptyMap(), catalogPage(firstLogId))
                        request.url.startsWith("https://second.example.com/") ->
                            HttpResponse(200, emptyMap(), catalogPage(secondLogId))
                        else -> error("unexpected HTTP request: $request")
                    }
                },
            ),
            backgroundAcquisition = true,
            afterAcquisitionCommitValidation = { _, username ->
                if (username == "first@example.com" && !acquisitionValidated.isCompleted) {
                    acquisitionValidated.complete(Unit)
                    check(releaseAcquisition.await(5, TimeUnit.SECONDS)) {
                        "Timed out while holding the validated acquisition commit"
                    }
                }
            },
        )
        try {
            service.refresh()
            withTimeout(5_000) { acquisitionValidated.await() }

            val selectionThread = CompletableDeferred<Thread>()
            val selection = async(Dispatchers.Default) {
                selectionThread.complete(Thread.currentThread())
                service.selectOrg("second@example.com")
            }
            val blockedThread = withTimeout(5_000) { selectionThread.await() }
            withTimeout(5_000) {
                while (blockedThread.state != Thread.State.BLOCKED) kotlinx.coroutines.yield()
            }

            releaseAcquisition.countDown()
            selection.await()
            val current = withTimeout(5_000) {
                service.state.first {
                    it.selectedOrg == "second@example.com" && !it.isRefreshing && !it.isAcquiringBodies
                }
            }
            assertEquals(listOf(secondLogId), current.logs.map(LogListRow::id))
            assertEquals(setOf(secondLogId), current.triageByLogId.keys)
        } finally {
            releaseAcquisition.countDown()
            service.dispose()
            scope.cancel()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testOrgSelectionCancelsAnAcquisitionRegisteredInsideTheFormerInvalidationWindow() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-project-org-acquisition-registration-")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val registrationReady = CompletableDeferred<Unit>()
        val releaseRegistration = CountDownLatch(1)
        val selectionWindow = CompletableDeferred<Unit>()
        val releaseSelection = CountDownLatch(1)
        val invalidationFinished = CompletableDeferred<Unit>()
        val releaseRefresh = CountDownLatch(1)
        val firstBodyStarted = CompletableDeferred<Unit>()
        val firstBodyCancelled = CompletableDeferred<Unit>()
        val blockFirstRegistration = AtomicBoolean(true)
        val service = ApexLogViewerProjectService(
            workspaceRoot,
            scope,
            RuntimeDependencies(
                process = twoOrgProcess(),
                http = RuntimeHttp { request ->
                    when {
                        request.url.startsWith("https://first.example.com/") && request.url.endsWith("/Body") -> {
                            firstBodyStarted.complete(Unit)
                            try {
                                kotlinx.coroutines.awaitCancellation()
                            } finally {
                                firstBodyCancelled.complete(Unit)
                            }
                        }
                        request.url.startsWith("https://second.example.com/") && request.url.endsWith("/Body") ->
                            HttpResponse(200, emptyMap(), "12:00:00.000 (1)|USER_DEBUG|second org\n")
                        request.url.startsWith("https://first.example.com/") ->
                            HttpResponse(200, emptyMap(), catalogPage("07L000000000190AAA"))
                        request.url.startsWith("https://second.example.com/") ->
                            HttpResponse(200, emptyMap(), catalogPage("07L000000000191AAA"))
                        else -> error("unexpected HTTP request: $request")
                    }
                },
            ),
            backgroundAcquisition = true,
            beforeAcquisitionJobRegistration = { _, username ->
                if (username == "first@example.com" && blockFirstRegistration.compareAndSet(true, false)) {
                    registrationReady.complete(Unit)
                    check(releaseRegistration.await(5, TimeUnit.SECONDS)) {
                        "Timed out releasing acquisition registration"
                    }
                }
            },
            beforeOrgSelectionInvalidation = {
                selectionWindow.complete(Unit)
                check(releaseSelection.await(5, TimeUnit.SECONDS)) {
                    "Timed out releasing org selection invalidation"
                }
            },
            afterOrgSelectionInvalidation = {
                invalidationFinished.complete(Unit)
                check(releaseRefresh.await(5, TimeUnit.SECONDS)) {
                    "Timed out releasing the selected-org refresh"
                }
            },
        )
        try {
            service.refresh()
            withTimeout(5_000) { registrationReady.await() }

            val selection = async(Dispatchers.Default) { service.selectOrg("second@example.com") }
            withTimeout(5_000) { selectionWindow.await() }
            releaseRegistration.countDown()
            withTimeout(5_000) { firstBodyStarted.await() }
            releaseSelection.countDown()
            withTimeout(5_000) { invalidationFinished.await() }

            withTimeout(1_000) { firstBodyCancelled.await() }

            releaseRefresh.countDown()
            selection.await()
        } finally {
            releaseRegistration.countDown()
            releaseSelection.countDown()
            releaseRefresh.countDown()
            service.dispose()
            scope.cancel()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testLateTriageFromAnotherOrgCannotOverwriteTheCurrentOrgWithTheSameLogId() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-project-org-triage-isolation-")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val firstTriageReady = CompletableDeferred<Unit>()
        val firstTriageCommitted = CompletableDeferred<Unit>()
        val releaseFirstTriage = CountDownLatch(1)
        val sharedLogId = "07L000000000183AAA"
        val service = ApexLogViewerProjectService(
            workspaceRoot,
            scope,
            RuntimeDependencies(
                process = twoOrgProcess(),
                http = RuntimeHttp { request ->
                    when {
                        request.url.startsWith("https://first.example.com/") && request.url.endsWith("/Body") ->
                            HttpResponse(200, emptyMap(), "12:00:00.000 (1)|FATAL_ERROR|first org failure\n")
                        request.url.startsWith("https://second.example.com/") && request.url.endsWith("/Body") ->
                            HttpResponse(200, emptyMap(), "12:00:00.000 (1)|USER_DEBUG|benign\n")
                        request.url.endsWith("/Body") -> error("unexpected body request: $request")
                        else -> HttpResponse(200, emptyMap(), catalogPage(sharedLogId))
                    }
                },
            ),
            backgroundAcquisition = true,
            beforeTriageSummaryCommit = { username, logId ->
                if (username == "first@example.com" && logId == sharedLogId) {
                    firstTriageReady.complete(Unit)
                    check(releaseFirstTriage.await(5, TimeUnit.SECONDS)) {
                        "Timed out releasing the first org triage"
                    }
                }
            },
            afterTriageSummaryCommit = { username, logId ->
                if (username == "first@example.com" && logId == sharedLogId) {
                    firstTriageCommitted.complete(Unit)
                }
            },
        )
        try {
            service.refresh()
            withTimeout(5_000) { firstTriageReady.await() }

            service.selectOrg("second@example.com")
            val second = withTimeout(5_000) {
                service.state.first {
                    it.selectedOrg == "second@example.com" &&
                        !it.isRefreshing &&
                        !it.isAcquiringBodies &&
                        it.triageByLogId.containsKey(sharedLogId)
                }
            }
            assertFalse(second.triageByLogId.getValue(sharedLogId).hasErrors)

            releaseFirstTriage.countDown()
            withTimeout(5_000) { firstTriageCommitted.await() }
            service.setViewOptions(service.state.value.viewOptions.copy(errorsOnly = true))

            assertTrue(service.state.value.logs.isEmpty())
            assertFalse(service.state.value.triageByLogId.getValue(sharedLogId).hasErrors)
        } finally {
            releaseFirstTriage.countDown()
            service.dispose()
            scope.cancel()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testBlockedRetentionPurgePreservesALogThatBecomesActiveOnALaterPage() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-project-retention-active-")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val firstLogId = "07L000000000184AAA"
        val laterLogId = "07L000000000185AAA"
        val laterLog = createStaleManagedLog(workspaceRoot, laterLogId)
        val protectionCheckStarted = CompletableDeferred<Unit>()
        val releaseProtectionCheck = CountDownLatch(1)
        val purgeFinished = CompletableDeferred<Unit>()
        val blockFirstCheck = AtomicBoolean(true)
        val pageRequests = AtomicInteger()
        val service = ApexLogViewerProjectService(
            workspaceRoot,
            scope,
            RuntimeDependencies(
                process = defaultOrgProcess(),
                http = RuntimeHttp {
                    val logId = if (pageRequests.incrementAndGet() == 1) firstLogId else laterLogId
                    HttpResponse(200, emptyMap(), catalogPage(logId))
                },
            ),
            pageSize = 1,
            beforeRetentionProtectionCheck = { logId ->
                if (logId == laterLogId && blockFirstCheck.compareAndSet(true, false)) {
                    protectionCheckStarted.complete(Unit)
                    check(releaseProtectionCheck.await(5, TimeUnit.SECONDS)) {
                        "Timed out releasing the retention protection check"
                    }
                }
            },
            afterRetentionPurge = { purgeFinished.complete(Unit) },
        )
        try {
            service.refresh()
            withTimeout(5_000) { protectionCheckStarted.await() }

            service.loadMore()
            withTimeout(5_000) {
                service.state.first { !it.isLoadingMore && it.logs.map(LogListRow::id).contains(laterLogId) }
            }
            releaseProtectionCheck.countDown()
            withTimeout(5_000) { purgeFinished.await() }

            assertTrue(Files.exists(laterLog))
        } finally {
            releaseProtectionCheck.countDown()
            service.dispose()
            scope.cancel()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testBlockedRetentionPurgeObservesAnOpenLogProtectionAcquiredAfterItsSnapshot() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-project-retention-open-")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val catalogLogId = "07L000000000186AAA"
        val openLogId = "07L000000000187AAA"
        val openLog = createStaleManagedLog(workspaceRoot, openLogId)
        val protectionCheckStarted = CompletableDeferred<Unit>()
        val releaseProtectionCheck = CountDownLatch(1)
        val purgeFinished = CompletableDeferred<Unit>()
        val blockFirstCheck = AtomicBoolean(true)
        val service = ApexLogViewerProjectService(
            workspaceRoot,
            scope,
            RuntimeDependencies(
                process = defaultOrgProcess(),
                http = RuntimeHttp { HttpResponse(200, emptyMap(), catalogPage(catalogLogId)) },
            ),
            beforeRetentionProtectionCheck = { logId ->
                if (logId == openLogId && blockFirstCheck.compareAndSet(true, false)) {
                    protectionCheckStarted.complete(Unit)
                    check(releaseProtectionCheck.await(5, TimeUnit.SECONDS)) {
                        "Timed out releasing the open-log protection check"
                    }
                }
            },
            afterRetentionPurge = { purgeFinished.complete(Unit) },
        )
        var protection: AutoCloseable? = null
        try {
            service.refresh()
            withTimeout(5_000) { protectionCheckStarted.await() }

            protection = service.protectOpenLog(openLogId)
            releaseProtectionCheck.countDown()
            withTimeout(5_000) { purgeFinished.await() }

            assertTrue(Files.exists(openLog))
        } finally {
            releaseProtectionCheck.countDown()
            protection?.close()
            service.dispose()
            scope.cancel()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testRetentionDeletionAndOpenLogProtectionAreSerializedWithBestEffortFilesystemDeletion() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-project-retention-serialized-")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val catalogLogId = "07L000000000192AAA"
        val candidateLogId = "07L000000000193AAA"
        val candidateLog = createStaleManagedLog(workspaceRoot, candidateLogId)
        val deletionValidated = CompletableDeferred<Unit>()
        val releaseDeletion = CountDownLatch(1)
        val purgeFinished = CompletableDeferred<Unit>()
        val blockCandidateDeletion = AtomicBoolean(true)
        val service = ApexLogViewerProjectService(
            workspaceRoot,
            scope,
            RuntimeDependencies(
                process = defaultOrgProcess(),
                http = RuntimeHttp { HttpResponse(200, emptyMap(), catalogPage(catalogLogId)) },
            ),
            afterRetentionDeletionValidation = { logId ->
                if (logId == candidateLogId && blockCandidateDeletion.compareAndSet(true, false)) {
                    deletionValidated.complete(Unit)
                    check(releaseDeletion.await(5, TimeUnit.SECONDS)) {
                        "Timed out releasing the serialized retention deletion"
                    }
                }
            },
            afterRetentionPurge = { purgeFinished.complete(Unit) },
        )
        var protection: AutoCloseable? = null
        try {
            service.refresh()
            withTimeout(5_000) { deletionValidated.await() }

            val protectionThread = CompletableDeferred<Thread>()
            val protectionAttempt = async(Dispatchers.Default) {
                protectionThread.complete(Thread.currentThread())
                service.protectOpenLog(candidateLogId)
            }
            val blockedThread = withTimeout(5_000) { protectionThread.await() }
            withTimeout(5_000) {
                while (blockedThread.state != Thread.State.BLOCKED) kotlinx.coroutines.yield()
            }
            assertFalse(protectionAttempt.isCompleted)

            releaseDeletion.countDown()
            protection = protectionAttempt.await()
            withTimeout(5_000) { purgeFinished.await() }

            // The protection decision remains serialized everywhere; deletion itself is intentionally
            // fail-closed on providers (notably Windows) without SecureDirectoryStream support.
            assertEquals(supportsSecurePurgeDeletion(workspaceRoot), !Files.exists(candidateLog))
        } finally {
            releaseDeletion.countDown()
            protection?.close()
            service.dispose()
            scope.cancel()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testDisposeCancelsABlockedRetentionPurgeWithoutDeletingItsCandidate() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-project-retention-dispose-")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val catalogLogId = "07L000000000188AAA"
        val candidateLogId = "07L000000000189AAA"
        val candidateLog = createStaleManagedLog(workspaceRoot, candidateLogId)
        val protectionCheckStarted = CompletableDeferred<Unit>()
        val releaseProtectionCheck = CountDownLatch(1)
        val purgeFinished = CompletableDeferred<Unit>()
        val blockFirstCheck = AtomicBoolean(true)
        val service = ApexLogViewerProjectService(
            workspaceRoot,
            scope,
            RuntimeDependencies(
                process = defaultOrgProcess(),
                http = RuntimeHttp { HttpResponse(200, emptyMap(), catalogPage(catalogLogId)) },
            ),
            beforeRetentionProtectionCheck = { logId ->
                if (logId == candidateLogId && blockFirstCheck.compareAndSet(true, false)) {
                    protectionCheckStarted.complete(Unit)
                    check(releaseProtectionCheck.await(5, TimeUnit.SECONDS)) {
                        "Timed out releasing the disposal protection check"
                    }
                }
            },
            afterRetentionPurge = { purgeFinished.complete(Unit) },
        )
        try {
            service.refresh()
            withTimeout(5_000) { protectionCheckStarted.await() }

            service.dispose()
            releaseProtectionCheck.countDown()
            withTimeout(5_000) { purgeFinished.await() }

            assertTrue(service.isDisposed)
            assertTrue(Files.exists(candidateLog))
        } finally {
            releaseProtectionCheck.countDown()
            if (!service.isDisposed) service.dispose()
            scope.cancel()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testCatalogCommitIsAtomicAgainstTheNextGenerationIncrement() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-project-refresh-atomic-")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val firstCommitValidated = CompletableDeferred<Unit>()
        val releaseFirstCommit = CountDownLatch(1)
        val orgListRequests = AtomicInteger()
        val pageRequests = AtomicInteger()
        val service = ApexLogViewerProjectService(
            workspaceRoot,
            scope,
            RuntimeDependencies(
                process = RuntimeProcess { request ->
                    when {
                        request.arguments == listOf("org", "list", "--json") -> {
                            val requestNumber = orgListRequests.incrementAndGet()
                            val username = if (requestNumber == 1) "first@example.com" else "second@example.com"
                            ProcessResponse(
                                0,
                                """{"status":0,"result":{"nonScratchOrgs":[{"username":"$username","isDefaultUsername":true}]}}""",
                                "",
                            )
                        }
                        request.arguments.firstOrNull() == "org" && request.arguments.getOrNull(1) == "display" -> {
                            val username = request.arguments[3]
                            ProcessResponse(
                                0,
                                """{"status":0,"result":{"username":"$username","instanceUrl":"https://example.my.salesforce.com","accessToken":"token","apiVersion":"63.0"}}""",
                                "",
                            )
                        }
                        else -> error("unexpected process request: $request")
                    }
                },
                http = RuntimeHttp {
                    val requestNumber = pageRequests.incrementAndGet()
                    val logId = if (requestNumber == 1) "07L000000000191AAA" else "07L000000000192AAA"
                    HttpResponse(
                        200,
                        emptyMap(),
                        """{"records":[{"Id":"$logId","StartTime":"2026-08-10T18:00:00.000Z"}]}""",
                    )
                },
            ),
            afterCatalogCommitValidation = { generation ->
                if (generation == 1L) {
                    firstCommitValidated.complete(Unit)
                    check(releaseFirstCommit.await(5, TimeUnit.SECONDS)) {
                        "Timed out while holding the first validated catalog commit"
                    }
                }
            },
        )
        try {
            service.refresh()
            withTimeout(5_000) { firstCommitValidated.await() }

            val secondRefreshThread = CompletableDeferred<Thread>()
            val secondRefresh = async(Dispatchers.Default) {
                secondRefreshThread.complete(Thread.currentThread())
                service.refresh()
            }
            val blockedThread = withTimeout(5_000) { secondRefreshThread.await() }
            withTimeout(5_000) {
                while (blockedThread.state != Thread.State.BLOCKED) kotlinx.coroutines.yield()
            }
            assertEquals("the replacement cannot increment while a validated commit is open", 1, orgListRequests.get())

            releaseFirstCommit.countDown()
            secondRefresh.await()
            val current = withTimeout(5_000) {
                service.state.first { !it.isRefreshing && it.selectedOrg == "second@example.com" }
            }
            assertEquals(listOf("07L000000000192AAA"), current.logs.map { it.id })
            assertEquals(2, orgListRequests.get())
        } finally {
            releaseFirstCommit.countDown()
            service.dispose()
            scope.cancel()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testStaleLoadMoreCompletionCannotAppendToReplacementCatalog() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-project-load-more-stale-")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val staleStarted = CountDownLatch(1)
        val releaseStale = CountDownLatch(1)
        val staleRejected = CompletableDeferred<Unit>()
        val catalogRequests = AtomicInteger()
        val service = ApexLogViewerProjectService(
            workspaceRoot,
            scope,
            RuntimeDependencies(
                process = defaultOrgProcess(),
                http = RuntimeHttp {
                    when (catalogRequests.incrementAndGet()) {
                        1 -> HttpResponse(200, emptyMap(), catalogPage("07L000000000201AAA"))
                        2 -> {
                            staleStarted.countDown()
                            check(releaseStale.await(5, TimeUnit.SECONDS)) { "Timed out releasing stale load more" }
                            HttpResponse(200, emptyMap(), catalogPage("07L000000000202AAA"))
                        }
                        3 -> HttpResponse(200, emptyMap(), catalogPage("07L000000000203AAA"))
                        else -> error("unexpected catalog request")
                    }
                },
            ),
            pageSize = 1,
            afterCatalogCommitRejection = { staleRejected.complete(Unit) },
        )
        try {
            service.refresh()
            withTimeout(5_000) { service.state.first { !it.isRefreshing && it.logs.singleOrNull()?.id == "07L000000000201AAA" } }
            service.loadMore()
            withContext(Dispatchers.IO) {
                check(staleStarted.await(5, TimeUnit.SECONDS)) { "Stale load more did not start" }
            }

            service.refresh()
            withTimeout(5_000) { service.state.first { !it.isRefreshing && it.logs.singleOrNull()?.id == "07L000000000203AAA" } }
            releaseStale.countDown()
            withTimeout(5_000) { staleRejected.await() }

            assertEquals(listOf("07L000000000203AAA"), service.state.value.logs.map(LogListRow::id))
        } finally {
            releaseStale.countDown()
            service.dispose()
            scope.cancel()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testStaleDownloadAllPageCannotAppendToReplacementCatalog() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-project-download-stale-")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val staleStarted = CountDownLatch(1)
        val releaseStale = CountDownLatch(1)
        val staleRejected = CompletableDeferred<Unit>()
        val catalogRequests = AtomicInteger()
        val service = ApexLogViewerProjectService(
            workspaceRoot,
            scope,
            RuntimeDependencies(
                process = defaultOrgProcess(),
                http = RuntimeHttp { request ->
                    if (request.url.endsWith("/Body")) {
                        HttpResponse(200, emptyMap(), "body")
                    } else {
                        when (catalogRequests.incrementAndGet()) {
                            1 -> HttpResponse(200, emptyMap(), catalogPage("07L000000000211AAA"))
                            2 -> {
                                staleStarted.countDown()
                                check(releaseStale.await(5, TimeUnit.SECONDS)) { "Timed out releasing stale download" }
                                HttpResponse(200, emptyMap(), catalogPage("07L000000000212AAA"))
                            }
                            3 -> HttpResponse(200, emptyMap(), catalogPage("07L000000000213AAA"))
                            else -> error("unexpected catalog request")
                        }
                    }
                },
            ),
            pageSize = 1,
            afterCatalogCommitRejection = { staleRejected.complete(Unit) },
        )
        try {
            service.refresh()
            withTimeout(5_000) { service.state.first { !it.isRefreshing && it.logs.singleOrNull()?.id == "07L000000000211AAA" } }
            service.downloadAll()
            withContext(Dispatchers.IO) {
                check(staleStarted.await(5, TimeUnit.SECONDS)) { "Stale download did not reach pagination" }
            }

            service.refresh()
            withTimeout(5_000) { service.state.first { !it.isRefreshing && it.logs.singleOrNull()?.id == "07L000000000213AAA" } }
            releaseStale.countDown()
            withTimeout(5_000) { staleRejected.await() }

            assertEquals(listOf("07L000000000213AAA"), service.state.value.logs.map(LogListRow::id))
            assertFalse(service.state.value.isDownloadingAll)
        } finally {
            releaseStale.countDown()
            service.dispose()
            scope.cancel()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testStaleRemoteSearchPageCannotMutateOrCheckpointReplacementCatalog() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-project-search-stale-")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val staleStarted = CountDownLatch(1)
        val releaseStale = CountDownLatch(1)
        val staleRejected = CompletableDeferred<Unit>()
        val catalogRequests = AtomicInteger()
        val service = ApexLogViewerProjectService(
            workspaceRoot,
            scope,
            RuntimeDependencies(
                process = defaultOrgProcess(),
                http = RuntimeHttp {
                    when (catalogRequests.incrementAndGet()) {
                        1 -> HttpResponse(200, emptyMap(), catalogPage("07L000000000221AAA"))
                        2 -> {
                            staleStarted.countDown()
                            check(releaseStale.await(5, TimeUnit.SECONDS)) { "Timed out releasing stale search" }
                            HttpResponse(200, emptyMap(), catalogPage("07L000000000222AAA"))
                        }
                        3 -> HttpResponse(200, emptyMap(), catalogPage("07L000000000223AAA"))
                        else -> HttpResponse(200, emptyMap(), """{"records":[]}""")
                    }
                },
            ),
            pageSize = 1,
            afterCatalogCommitRejection = { staleRejected.complete(Unit) },
        )
        try {
            service.refresh()
            withTimeout(5_000) { service.state.first { !it.isRefreshing && it.logs.singleOrNull()?.id == "07L000000000221AAA" } }
            service.setViewOptions(
                service.state.value.viewOptions.copy(
                    sortField = LogSortField.LOG_ID,
                    sortDirection = LogSortDirection.ASCENDING,
                ),
            )
            service.setSearchQuery("needle")
            withContext(Dispatchers.IO) {
                check(staleStarted.await(5, TimeUnit.SECONDS)) { "Stale search page did not start" }
            }

            service.refresh()
            withTimeout(5_000) { service.state.first { !it.isRefreshing && it.logs.singleOrNull()?.id == "07L000000000223AAA" } }
            service.cancelSearch()
            releaseStale.countDown()
            withTimeout(5_000) { staleRejected.await() }

            assertEquals(listOf("07L000000000223AAA"), service.state.value.logs.map(LogListRow::id))
            assertFalse(service.state.value.logs.any { it.id == "07L000000000222AAA" })
        } finally {
            releaseStale.countDown()
            service.dispose()
            scope.cancel()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testSearchCheckpointCommitIsAtomicAgainstCatalogGenerationIncrement() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-project-search-checkpoint-atomic-")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val checkpointValidated = CompletableDeferred<Unit>()
        val releaseCheckpoint = CountDownLatch(1)
        val catalogRequests = AtomicInteger()
        val service = ApexLogViewerProjectService(
            workspaceRoot,
            scope,
            RuntimeDependencies(
                process = defaultOrgProcess(),
                http = RuntimeHttp {
                    when (catalogRequests.incrementAndGet()) {
                        1 -> HttpResponse(200, emptyMap(), catalogPage("07L000000000231AAA"))
                        2 -> HttpResponse(200, emptyMap(), """{"records":[]}""")
                        3 -> HttpResponse(200, emptyMap(), catalogPage("07L000000000233AAA"))
                        else -> HttpResponse(200, emptyMap(), """{"records":[]}""")
                    }
                },
            ),
            pageSize = 1,
            afterSearchCheckpointValidation = { generation ->
                if (generation == 1L) {
                    checkpointValidated.complete(Unit)
                    check(releaseCheckpoint.await(5, TimeUnit.SECONDS)) {
                        "Timed out while holding the validated search checkpoint"
                    }
                }
            },
        )
        try {
            service.refresh()
            withTimeout(5_000) { service.state.first { !it.isRefreshing && it.logs.singleOrNull()?.id == "07L000000000231AAA" } }
            service.setViewOptions(
                service.state.value.viewOptions.copy(
                    sortField = LogSortField.LOG_ID,
                    sortDirection = LogSortDirection.ASCENDING,
                ),
            )
            service.setSearchQuery("needle")
            withTimeout(5_000) { checkpointValidated.await() }

            val refreshThread = CompletableDeferred<Thread>()
            val replacement = async(Dispatchers.Default) {
                refreshThread.complete(Thread.currentThread())
                service.refresh()
            }
            val blockedThread = withTimeout(5_000) { refreshThread.await() }
            withTimeout(5_000) {
                while (blockedThread.state != Thread.State.BLOCKED) kotlinx.coroutines.yield()
            }
            assertEquals(2, catalogRequests.get())

            releaseCheckpoint.countDown()
            replacement.await()
            withTimeout(5_000) { service.state.first { !it.isRefreshing && it.logs.singleOrNull()?.id == "07L000000000233AAA" } }
            service.cancelSearch()
            assertEquals(listOf("07L000000000233AAA"), service.state.value.logs.map(LogListRow::id))
        } finally {
            releaseCheckpoint.countDown()
            service.dispose()
            scope.cancel()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testCancelledRefreshCannotPublishAfterItsReplacement() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-project-refresh-generation-")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val firstOrgGate = CompletableDeferred<Unit>()
        val orgListRequests = AtomicInteger()
        val displayedOrgs = mutableListOf<String>()
        val service = ApexLogViewerProjectService(
            workspaceRoot,
            scope,
            RuntimeDependencies(
                process = RuntimeProcess { request ->
                    when {
                        request.arguments == listOf("org", "list", "--json") -> {
                            val requestNumber = orgListRequests.incrementAndGet()
                            if (requestNumber == 1) withContext(NonCancellable) { firstOrgGate.await() }
                            val username = if (requestNumber == 1) "stale@example.com" else "current@example.com"
                            ProcessResponse(
                                0,
                                """{"status":0,"result":{"nonScratchOrgs":[{"username":"$username","isDefaultUsername":true}]}}""",
                                "",
                            )
                        }
                        request.arguments.firstOrNull() == "org" && request.arguments.getOrNull(1) == "display" -> {
                            val username = request.arguments[3]
                            synchronized(displayedOrgs) { displayedOrgs += username }
                            ProcessResponse(
                                0,
                                """{"status":0,"result":{"username":"$username","instanceUrl":"https://example.my.salesforce.com","accessToken":"token","apiVersion":"63.0"}}""",
                                "",
                            )
                        }
                        else -> error("unexpected process request: $request")
                    }
                },
                http = RuntimeHttp {
                    HttpResponse(
                        200,
                        emptyMap(),
                        """{"records":[{"Id":"07L000000000199AAA","StartTime":"2026-08-10T18:00:00.000Z"}]}""",
                    )
                },
            ),
        )
        try {
            service.refresh()
            withTimeout(5_000) { while (orgListRequests.get() < 1) kotlinx.coroutines.yield() }
            service.refresh()
            val current = withTimeout(5_000) {
                service.state.first { !it.isRefreshing && it.selectedOrg == "current@example.com" }
            }
            firstOrgGate.complete(Unit)
            kotlinx.coroutines.delay(100)

            assertEquals("current@example.com", current.selectedOrg)
            assertEquals("current@example.com", service.state.value.selectedOrg)
            assertEquals(listOf("current@example.com"), synchronized(displayedOrgs) { displayedOrgs.toList() })
        } finally {
            firstOrgGate.complete(Unit)
            service.dispose()
            scope.cancel()
            deleteRecursively(workspaceRoot)
        }
    }

    private fun defaultOrgProcess(): RuntimeProcess = RuntimeProcess { request ->
        when {
            request.arguments == listOf("org", "list", "--json") -> ProcessResponse(
                0,
                """{"status":0,"result":{"nonScratchOrgs":[{"username":"default@example.com","isDefaultUsername":true}]}}""",
                "",
            )
            request.arguments == listOf("org", "display", "--target-org", "default@example.com", "--json") -> {
                ProcessResponse(
                    0,
                    """{"status":0,"result":{"username":"default@example.com","instanceUrl":"https://example.my.salesforce.com","accessToken":"token","apiVersion":"63.0"}}""",
                    "",
                )
            }
            else -> error("unexpected process request: $request")
        }
    }

    private fun twoOrgProcess(): RuntimeProcess = RuntimeProcess { request ->
        when {
            request.arguments == listOf("org", "list", "--json") -> ProcessResponse(
                0,
                """{"status":0,"result":{"nonScratchOrgs":[{"username":"first@example.com","isDefaultUsername":true},{"username":"second@example.com"}]}}""",
                "",
            )
            request.arguments.firstOrNull() == "org" && request.arguments.getOrNull(1) == "display" -> {
                val username = request.arguments[3]
                val host = if (username == "first@example.com") "first.example.com" else "second.example.com"
                ProcessResponse(
                    0,
                    """{"status":0,"result":{"username":"$username","instanceUrl":"https://$host","accessToken":"token","apiVersion":"63.0"}}""",
                    "",
                )
            }
            else -> error("unexpected process request: $request")
        }
    }

    private fun catalogPage(logId: String): String =
        """{"records":[{"Id":"$logId","StartTime":"2026-08-10T18:00:00.000Z","Status":"Success"}]}"""

    private fun createStaleManagedLog(workspaceRoot: Path, logId: String): Path {
        val path = workspaceRoot.resolve("apexlogs/orgs/default@example.com/logs/2026-08-10/$logId.log")
        Files.createDirectories(path.parent)
        Files.writeString(path, "stale body")
        Files.setLastModifiedTime(path, FileTime.fromMillis(0))
        return path
    }

    private fun deleteRecursively(root: Path) {
        Files.walk(root).use { paths -> paths.sorted(Comparator.reverseOrder()).forEach(Files::deleteIfExists) }
    }
}
