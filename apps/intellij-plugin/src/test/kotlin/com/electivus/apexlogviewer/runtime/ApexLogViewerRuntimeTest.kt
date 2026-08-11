package com.electivus.apexlogviewer.runtime

import com.google.gson.JsonParser
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.FileTime
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import java.util.Comparator
import java.util.concurrent.CyclicBarrier
import java.util.concurrent.atomic.AtomicBoolean
import junit.framework.TestCase
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout

// This suite intentionally compiles Kotlin default-argument call sites against the current runtime DTO ABI.
class ApexLogViewerRuntimeTest : TestCase() {
    private val salesforceTestEnvironment = mapOf(
        "FORCE_COLOR" to "0",
        "SF_CONTENT_TYPE" to "JSON",
        "SF_HIDE_RELEASE_NOTES" to "true",
    )

    fun testSalesforceCliJsonParserAcceptsAnsiStyledJson() {
        val envelope = parseSalesforceCliJsonObject(
            "\u001B[97m{\u001B[39m\n" +
                "  \u001B[94m\"status\"\u001B[39m: \u001B[34m0\u001B[39m,\n" +
                "  \u001B[94m\"result\"\u001B[39m: \u001B[97m{\u001B[39m\"value\":true\u001B[97m}\u001B[39m\n" +
                "\u001B[97m}\u001B[39m",
        )

        assertEquals(0, envelope.get("status").asInt)
        assertTrue(envelope.getAsJsonObject("result").get("value").asBoolean)
    }

    fun testExclusiveCompletedFilePublicationNeverOverwritesTheWinner() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-exclusive-publish-")
        val target = workspaceRoot.resolve("apexlogs/orgs/demo@example.com/logs/2026-08-11/07L000000000096AAA.log")
        Files.createDirectories(target.parent)
        val firstTemporary = Files.writeString(target.parent.resolve("first.tmp"), "first body")
        val secondTemporary = Files.writeString(target.parent.resolve("second.tmp"), "second body")
        val barrier = CyclicBarrier(2)
        try {
            val outcomes = listOf(firstTemporary, secondTemporary).map { temporary ->
                async(Dispatchers.IO) {
                    barrier.await()
                    publishCompletedFileIfAbsent(target, temporary)
                }
            }.awaitAll()

            assertEquals(1, outcomes.count { it })
            val winner = Files.readString(target)
            assertTrue("unexpected published body: $winner", winner == "first body" || winner == "second body")
            Files.writeString(if (winner == "first body") secondTemporary else firstTemporary, "changed loser")
            assertEquals(winner, Files.readString(target))
        } finally {
            deleteRecursively(workspaceRoot)
        }
    }

    fun testRequireLocalLogUsesCanonicalAndLegacyBodiesWithoutSalesforceAuthentication() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-local-first-")
        val canonicalId = "07L000000000097AAA"
        val legacyId = "07L000000000098AAA"
        val canonical = workspaceRoot.resolve(
            "apexlogs/orgs/demo@example.com/logs/2026-08-10/$canonicalId.log",
        )
        val legacy = workspaceRoot.resolve("apexlogs/demo@example.com_$legacyId.log")
        Files.createDirectories(canonical.parent)
        Files.writeString(canonical, "canonical body")
        Files.writeString(legacy, "legacy body")
        val runtime = createApexLogViewerRuntime(
            RuntimeDependencies(
                process = RuntimeProcess { error("Salesforce CLI must not run for dependable local bodies") },
                http = RuntimeHttp { error("HTTP must not run for dependable local bodies") },
            ),
        )
        try {
            val canonicalResult = runtime.requireLocalLog(
                RequireLocalLogRequest(
                    workspaceRoot,
                    "demo@example.com",
                    LogListRow(canonicalId, "2026-08-10T18:00:00.000Z"),
                ),
            )
            val legacyResult = runtime.requireLocalLog(
                RequireLocalLogRequest(workspaceRoot, "demo@example.com", LogListRow(legacyId)),
            )

            assertEquals(canonical, canonicalResult.localPath)
            assertEquals(legacy, legacyResult.localPath)
            assertEquals(listOf("existing", "existing"), listOf(canonicalResult.persistence, legacyResult.persistence))
        } finally {
            runtime.close()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testRequireLocalLogRejectsLinkedLifecycleRootsBeforeWriting() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-linked-root-")
        val outside = Files.createTempDirectory("alv-runtime-linked-outside-")
        try {
            try {
                Files.createSymbolicLink(workspaceRoot.resolve("apexlogs"), outside)
            } catch (_: Exception) {
                return@runBlocking
            }
            val runtime = createApexLogViewerRuntime(
                RuntimeDependencies(
                    process = RuntimeProcess { error("Salesforce CLI must not run for an unsafe lifecycle root") },
                    http = RuntimeHttp { error("HTTP must not run for an unsafe lifecycle root") },
                ),
            )
            try {
                val failure = captureFailure {
                    runtime.requireLocalLog(
                        RequireLocalLogRequest(
                            workspaceRoot,
                            "demo@example.com",
                            LogListRow("07L000000000099AAA", "2026-08-10T18:00:00.000Z"),
                        ),
                    )
                }
                assertEquals("local-persistence", failure.code)
                assertEquals(emptyList<String>(), Files.list(outside).use { paths -> paths.map { it.fileName.toString() }.toList() })
            } finally {
                runtime.close()
            }
        } finally {
            deleteRecursively(workspaceRoot)
            deleteRecursively(outside)
        }
    }

    fun testLogStatusRejectsLinkedSyncStateParentsBeforeReading() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-linked-state-")
        val outside = Files.createTempDirectory("alv-runtime-linked-state-outside-")
        Files.createDirectories(workspaceRoot.resolve("apexlogs"))
        Files.writeString(outside.resolve("sync-state.json"), """{"version":1,"orgs":{}}""")
        try {
            try {
                Files.createSymbolicLink(workspaceRoot.resolve("apexlogs/.alv"), outside)
            } catch (_: Exception) {
                return@runBlocking
            }
            val runtime = createApexLogViewerRuntime()
            try {
                val failure = captureFailure { runtime.logStatus(LogStatusRequest(workspaceRoot)) }
                assertEquals("local-persistence", failure.code)
            } finally {
                runtime.close()
            }
        } finally {
            deleteRecursively(workspaceRoot)
            deleteRecursively(outside)
        }
    }

    fun testLocalSearchCacheInvalidatesWhenAFileChangesWithoutChangingSize() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-search-cache-")
        val logId = "07L000000000019AAA"
        val canonical = workspaceRoot.resolve(
            "apexlogs/orgs/demo@example.com/logs/2026-08-10/$logId.log",
        )
        Files.createDirectories(canonical.parent)
        Files.writeString(canonical, "prefix needle suffix\n")
        val log = LogListRow(logId, startTime = "2026-08-10T18:00:00.000Z", status = "Success")
        val runtime = createApexLogViewerRuntime()
        try {
            val first = runtime.searchLocalLogs(
                LocalLogSearchRequest(workspaceRoot, "demo@example.com", "needle", listOf(log), concurrency = 16),
            )
            assertEquals(listOf(logId), first.matches.map { it.logId })

            Files.writeString(canonical, "prefix absent suffix\n")
            Files.setLastModifiedTime(canonical, FileTime.fromMillis(System.currentTimeMillis() + 5_000))

            val changed = runtime.searchLocalLogs(
                LocalLogSearchRequest(workspaceRoot, "demo@example.com", "needle", listOf(log), concurrency = 16),
            )
            assertTrue(changed.matches.isEmpty())
            assertTrue(changed.pendingLogIds.isEmpty())
        } finally {
            runtime.close()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testPurgeExpiredLogsDeletesOnlyUnprotectedLifecycleBodies() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-purge-")
        val expiredId = "07L000000000081AAA"
        val protectedId = "07L000000000082AAA"
        val freshId = "07L000000000083AAA"
        val logsRoot = workspaceRoot.resolve("apexlogs/orgs/demo@example.com/logs/2026-08-09")
        Files.createDirectories(logsRoot)
        val expired = Files.writeString(logsRoot.resolve("$expiredId.log"), "expired")
        val protected = Files.writeString(logsRoot.resolve("$protectedId.log"), "protected")
        val fresh = Files.writeString(logsRoot.resolve("$freshId.log"), "fresh")
        val unrelated = Files.writeString(workspaceRoot.resolve("unrelated.log"), "outside lifecycle")
        val now = Instant.parse("2026-08-10T22:00:00Z")
        Files.setLastModifiedTime(expired, FileTime.from(now.minusSeconds(25 * 60 * 60)))
        Files.setLastModifiedTime(protected, FileTime.from(now.minusSeconds(25 * 60 * 60)))
        Files.setLastModifiedTime(fresh, FileTime.from(now.minusSeconds(23 * 60 * 60)))
        val runtime = createApexLogViewerRuntime(
            RuntimeDependencies(
                process = RuntimeProcess { error("process must not run") },
                http = RuntimeHttp { error("HTTP must not run") },
                clock = Clock.fixed(now, ZoneOffset.UTC),
            ),
        )
        try {
            val secureDeletionAvailable = supportsSecurePurgeDeletion(workspaceRoot)
            assertEquals(
                if (secureDeletionAvailable) {
                    PurgeLocalLogsResult(deleted = 1, retained = 2, failed = 0)
                } else {
                    PurgeLocalLogsResult(deleted = 0, retained = 2, failed = 1)
                },
                runtime.purgeLocalLogs(PurgeLocalLogsRequest(workspaceRoot, setOf(protectedId))),
            )
            assertEquals(secureDeletionAvailable, !Files.exists(expired))
            assertTrue(Files.exists(protected))
            assertTrue(Files.exists(fresh))
            assertTrue(Files.exists(unrelated))
        } finally {
            runtime.close()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testPurgeExpiredLegacyLogUsesSecureDeletionWhenTheProviderSupportsIt() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-purge-legacy-")
        val logId = "07L000000000095AAA"
        val legacy = workspaceRoot.resolve("apexlogs/demo@example.com_$logId.log")
        Files.createDirectories(legacy.parent)
        Files.writeString(legacy, "expired legacy body")
        val now = Instant.parse("2026-08-10T22:00:00Z")
        Files.setLastModifiedTime(legacy, FileTime.from(now.minusSeconds(25 * 60 * 60)))
        val runtime = createApexLogViewerRuntime(
            RuntimeDependencies(
                process = RuntimeProcess { error("process must not run") },
                http = RuntimeHttp { error("HTTP must not run") },
                clock = Clock.fixed(now, ZoneOffset.UTC),
            ),
        )
        try {
            val secureDeletionAvailable = supportsSecurePurgeDeletion(workspaceRoot)
            assertEquals(
                if (secureDeletionAvailable) {
                    PurgeLocalLogsResult(deleted = 1, retained = 0, failed = 0)
                } else {
                    PurgeLocalLogsResult(deleted = 0, retained = 0, failed = 1)
                },
                runtime.purgeLocalLogs(PurgeLocalLogsRequest(workspaceRoot)),
            )
            assertEquals(secureDeletionAvailable, !Files.exists(legacy))
        } finally {
            runtime.close()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testPurgeDeletionGuardCanProtectACandidateWithoutExecutingDelete() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-purge-live-protection-")
        val logId = "07L000000000084AAA"
        val log = workspaceRoot.resolve("apexlogs/orgs/demo@example.com/logs/2026-08-09/$logId.log")
        Files.createDirectories(log.parent)
        Files.writeString(log, "expired")
        val now = Instant.parse("2026-08-10T22:00:00Z")
        Files.setLastModifiedTime(log, FileTime.from(now.minusSeconds(25 * 60 * 60)))
        val runtime = createApexLogViewerRuntime(
            RuntimeDependencies(
                process = RuntimeProcess { error("process must not run") },
                http = RuntimeHttp { error("HTTP must not run") },
                clock = Clock.fixed(now, ZoneOffset.UTC),
            ),
        )
        try {
            assertEquals(
                PurgeLocalLogsResult(deleted = 0, retained = 1, failed = 0),
                runtime.purgeLocalLogs(
                    PurgeLocalLogsRequest(
                        workspaceRoot = workspaceRoot,
                        deletionGuard = PurgeDeletionGuard { _, _ ->
                            PurgeDeletionOutcome.PROTECTED
                        },
                    ),
                ),
            )
            assertTrue(Files.exists(log))
        } finally {
            runtime.close()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testPurgeDeletionGuardExecutesDeleteExactlyOnceForADeletedCandidate() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-purge-guard-delete-")
        val logId = "07L000000000087AAA"
        val log = workspaceRoot.resolve("apexlogs/orgs/demo@example.com/logs/2026-08-09/$logId.log")
        Files.createDirectories(log.parent)
        Files.writeString(log, "expired")
        val now = Instant.parse("2026-08-10T22:00:00Z")
        Files.setLastModifiedTime(log, FileTime.from(now.minusSeconds(25 * 60 * 60)))
        var deleteCalls = 0
        val runtime = createApexLogViewerRuntime(
            RuntimeDependencies(
                process = RuntimeProcess { error("process must not run") },
                http = RuntimeHttp { error("HTTP must not run") },
                clock = Clock.fixed(now, ZoneOffset.UTC),
            ),
        )
        try {
            val secureDeletionAvailable = supportsSecurePurgeDeletion(workspaceRoot)
            assertEquals(
                if (secureDeletionAvailable) {
                    PurgeLocalLogsResult(deleted = 1, retained = 0, failed = 0)
                } else {
                    PurgeLocalLogsResult(deleted = 0, retained = 0, failed = 1)
                },
                runtime.purgeLocalLogs(
                    PurgeLocalLogsRequest(
                        workspaceRoot = workspaceRoot,
                        deletionGuard = PurgeDeletionGuard { _, delete ->
                            deleteCalls += 1
                            if (delete()) PurgeDeletionOutcome.DELETED else PurgeDeletionOutcome.MISSING
                        },
                    ),
                ),
            )
            assertEquals(1, deleteCalls)
            assertEquals(secureDeletionAvailable, !Files.exists(log))
        } finally {
            runtime.close()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testPurgeDoesNotFollowAReplacedCanonicalDayDirectoryDuringGuardedDeletion() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-purge-parent-swap-")
        val outsideRoot = Files.createTempDirectory("alv-runtime-purge-parent-swap-outside-")
        val logId = "07L000000000094AAA"
        val day = workspaceRoot.resolve("apexlogs/orgs/demo@example.com/logs/2026-08-09")
        val displacedDay = day.resolveSibling("2026-08-09.displaced")
        val candidate = day.resolve("$logId.log")
        val outsideLog = outsideRoot.resolve("$logId.log")
        Files.createDirectories(day)
        Files.writeString(candidate, "expired inside body")
        Files.writeString(outsideLog, "outside body must survive")
        val now = Instant.parse("2026-08-10T22:00:00Z")
        Files.setLastModifiedTime(candidate, FileTime.from(now.minusSeconds(25 * 60 * 60)))
        Files.setLastModifiedTime(outsideLog, FileTime.from(now.minusSeconds(25 * 60 * 60)))
        var linkCreated = false
        var guardCalls = 0
        var secondDeleteRejected = false
        val runtime = createApexLogViewerRuntime(
            RuntimeDependencies(
                process = RuntimeProcess { error("process must not run") },
                http = RuntimeHttp { error("HTTP must not run") },
                clock = Clock.fixed(now, ZoneOffset.UTC),
            ),
        )
        try {
            val result = runtime.purgeLocalLogs(
                PurgeLocalLogsRequest(
                    workspaceRoot = workspaceRoot,
                    deletionGuard = PurgeDeletionGuard { _, delete ->
                        guardCalls += 1
                        Files.move(day, displacedDay)
                        createDirectoryLink(day, outsideRoot)
                        linkCreated = true
                        val secureFailure = checkNotNull(runCatching { delete() }.exceptionOrNull())
                        secondDeleteRejected = runCatching { delete() }.exceptionOrNull() is IllegalStateException
                        throw secureFailure
                    },
                ),
            )

            assertEquals(PurgeLocalLogsResult(deleted = 0, retained = 0, failed = 1), result)
            assertEquals(1, guardCalls)
            assertTrue("the guarded deletion closure accepted a second invocation", secondDeleteRejected)
            assertEquals("outside body must survive", Files.readString(outsideLog))
            assertTrue(Files.exists(displacedDay.resolve("$logId.log")))
        } finally {
            runtime.close()
            if (linkCreated) Files.deleteIfExists(day)
            deleteRecursively(workspaceRoot)
            deleteRecursively(outsideRoot)
        }
    }

    fun testPurgeDoesNotDeleteThroughAReparsePointReplacingTheFinalBody() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-purge-final-reparse-")
        val outsideRoot = Files.createTempDirectory("alv-runtime-purge-final-reparse-outside-")
        val logId = "07L000000000099AAA"
        val candidate = workspaceRoot.resolve("apexlogs/orgs/demo@example.com/logs/2026-08-09/$logId.log")
        val displaced = candidate.resolveSibling("$logId.displaced")
        val outsideSentinel = outsideRoot.resolve("outside.txt")
        Files.createDirectories(candidate.parent)
        Files.writeString(candidate, "expired inside body")
        Files.writeString(outsideSentinel, "outside body must survive")
        val now = Instant.parse("2026-08-10T22:00:00Z")
        Files.setLastModifiedTime(candidate, FileTime.from(now.minusSeconds(25 * 60 * 60)))
        var linkCreated = false
        val runtime = createApexLogViewerRuntime(
            RuntimeDependencies(
                process = RuntimeProcess { error("process must not run") },
                http = RuntimeHttp { error("HTTP must not run") },
                clock = Clock.fixed(now, ZoneOffset.UTC),
            ),
        )
        try {
            val result = runtime.purgeLocalLogs(
                PurgeLocalLogsRequest(
                    workspaceRoot = workspaceRoot,
                    deletionGuard = PurgeDeletionGuard { _, delete ->
                        Files.move(candidate, displaced)
                        createDirectoryLink(candidate, outsideRoot)
                        linkCreated = true
                        if (delete()) PurgeDeletionOutcome.DELETED else PurgeDeletionOutcome.MISSING
                    },
                ),
            )

            assertEquals(PurgeLocalLogsResult(deleted = 0, retained = 0, failed = 1), result)
            assertEquals("outside body must survive", Files.readString(outsideSentinel))
            assertEquals("expired inside body", Files.readString(displaced))
        } finally {
            runtime.close()
            if (linkCreated) Files.deleteIfExists(candidate)
            deleteRecursively(workspaceRoot)
            deleteRecursively(outsideRoot)
        }
    }

    fun testPurgeHonorsCancellationBeforeDeletingACandidate() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-purge-cancel-")
        val logId = "07L000000000085AAA"
        val log = workspaceRoot.resolve("apexlogs/orgs/demo@example.com/logs/2026-08-09/$logId.log")
        Files.createDirectories(log.parent)
        Files.writeString(log, "expired")
        val now = Instant.parse("2026-08-10T22:00:00Z")
        Files.setLastModifiedTime(log, FileTime.from(now.minusSeconds(25 * 60 * 60)))
        val runtime = createApexLogViewerRuntime(
            RuntimeDependencies(
                process = RuntimeProcess { error("process must not run") },
                http = RuntimeHttp { error("HTTP must not run") },
                clock = Clock.fixed(now, ZoneOffset.UTC),
            ),
        )
        try {
            val operation = async(Dispatchers.Default) {
                val operationJob = checkNotNull(currentCoroutineContext()[kotlinx.coroutines.Job])
                runtime.purgeLocalLogs(
                    PurgeLocalLogsRequest(
                        workspaceRoot = workspaceRoot,
                        deletionGuard = PurgeDeletionGuard { _, delete ->
                            operationJob.cancel()
                            if (delete()) PurgeDeletionOutcome.DELETED else PurgeDeletionOutcome.MISSING
                        },
                    ),
                )
            }
            val failure = runCatching { operation.await() }.exceptionOrNull()
            assertTrue("expected cancellation but got $failure", failure is CancellationException)
            assertTrue(Files.exists(log))
        } finally {
            runtime.close()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testLogPagePropagatesCancellationFromOrgResolution() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-process-cancel-")
        val started = CompletableDeferred<Unit>()
        val runtime = createApexLogViewerRuntime(
            RuntimeDependencies(
                process = RuntimeProcess {
                    started.complete(Unit)
                    awaitCancellation()
                },
                http = RuntimeHttp { error("HTTP must not run while org resolution is suspended") },
            ),
        )
        try {
            val operation = async(Dispatchers.Default) {
                runtime.logPage(LogPageRequest(workspaceRoot, "demo@example.com"))
            }
            started.await()
            operation.cancel()
            val failure = runCatching { operation.await() }.exceptionOrNull()
            assertTrue("expected cancellation but got $failure", failure is CancellationException)
        } finally {
            runtime.close()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testRequireLocalLogPropagatesCancellationFromHttp() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-http-cancel-")
        val started = CompletableDeferred<Unit>()
        val runtime = createApexLogViewerRuntime(
            RuntimeDependencies(
                process = RuntimeProcess {
                    ProcessResponse(
                        0,
                        """{"status":0,"result":{"username":"demo@example.com","instanceUrl":"https://example.my.salesforce.com","accessToken":"token","apiVersion":"63.0"}}""",
                        "",
                    )
                },
                http = RuntimeHttp {
                    started.complete(Unit)
                    awaitCancellation()
                },
            ),
        )
        try {
            val operation = async(Dispatchers.Default) {
                runtime.requireLocalLog(
                    RequireLocalLogRequest(
                        workspaceRoot,
                        "demo@example.com",
                        LogListRow("07L000000000086AAA", "2026-08-10T18:00:00.000Z"),
                    ),
                )
            }
            started.await()
            operation.cancel()
            val failure = runCatching { operation.await() }.exceptionOrNull()
            assertTrue("expected cancellation but got $failure", failure is CancellationException)
        } finally {
            runtime.close()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testToolingRequestRefreshesAuthenticationOnceAfterUnauthorized() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-auth-retry-")
        var resolutions = 0
        val processRequests = mutableListOf<ProcessRequest>()
        val authorizationHeaders = mutableListOf<String?>()
        val runtime = createApexLogViewerRuntime(
            RuntimeDependencies(
                process = RuntimeProcess { request ->
                    processRequests += request
                    resolutions += 1
                    ProcessResponse(
                        0,
                        """{"status":0,"result":{"username":"demo@example.com","instanceUrl":"https://example.my.salesforce.com","accessToken":"token-$resolutions","apiVersion":"63.0"}}""",
                        "",
                    )
                },
                http = RuntimeHttp { request ->
                    authorizationHeaders += request.headers["Authorization"]
                    if (authorizationHeaders.size == 1) HttpResponse(401, emptyMap(), "expired") else {
                        HttpResponse(200, emptyMap(), """{"records":[]}""")
                    }
                },
            ),
        )
        try {
            assertEquals(emptyList<LogListRow>(), runtime.logList(LogListRequest(workspaceRoot, "demo@example.com")))
            assertEquals(2, resolutions)
            assertEquals(listOf("Bearer token-1", "Bearer token-2"), authorizationHeaders)
            assertTrue(processRequests.all { it.arguments.take(2) == listOf("org", "display") })
            assertTrue(processRequests.all { it.environment == salesforceTestEnvironment })
        } finally {
            runtime.close()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testConcurrentMaterializationKeepsOneAtomicLifecycleBody() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-concurrent-")
        val barrier = CyclicBarrier(2)
        val runtime = createApexLogViewerRuntime(
            RuntimeDependencies(
                process = RuntimeProcess {
                    ProcessResponse(0, """{"status":0,"result":{"username":"demo@example.com","instanceUrl":"https://example.my.salesforce.com","accessToken":"token","apiVersion":"63.0"}}""", "")
                },
                http = RuntimeHttp {
                    barrier.await()
                    HttpResponse(200, emptyMap(), "dependable body")
                },
            ),
        )
        val request = RequireLocalLogRequest(
            workspaceRoot,
            "demo@example.com",
            LogListRow("07L000000000071AAA", "2026-08-10T18:00:00.000Z"),
        )
        try {
            val results = listOf(
                async(Dispatchers.Default) { runtime.requireLocalLog(request) },
                async(Dispatchers.Default) { runtime.requireLocalLog(request) },
            ).awaitAll()
            assertEquals(listOf("existing", "written"), results.map { it.persistence }.sorted())
            assertEquals("dependable body", Files.readString(results.first().localPath))
            assertEquals(
                listOf("07L000000000071AAA.log"),
                Files.list(results.first().localPath.parent).use { paths -> paths.map { it.fileName.toString() }.sorted().toList() },
            )
        } finally {
            runtime.close()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testTriageLogPrioritizesValidationFailureAndRetainsRollbackWarning() = runBlocking {
        val localLog = Files.createTempFile("alv-runtime-triage-", ".log")
        Files.writeString(
            localLog,
            "17:11:52.319 (372616766)|VARIABLE_ASSIGNMENT|[131]|error|\"Error [statusCode=FIELD_CUSTOM_VALIDATION_EXCEPTION, code=null, message=Could not save, fields=[Name]]\"|0x3722c840\n" +
                "17:11:52.525 (530873859)|ROLLBACK|[111]|Savepoint restored",
        )
        val runtime = createApexLogViewerRuntime()
        try {
            assertEquals(
                LogTriageSummary(
                    hasErrors = true,
                    primaryReason = "Validation failure",
                    reasons = listOf(
                        LogDiagnostic("validation_failure", "error", "Validation failure", 131, "VARIABLE_ASSIGNMENT"),
                        LogDiagnostic("rollback_detected", "warning", "Rollback detected", 111, "ROLLBACK"),
                    ),
                ),
                runtime.triageLog(ParseLogRequest(localLog)),
            )
        } finally {
            runtime.close()
            Files.deleteIfExists(localLog)
        }
    }

    fun testParseLogKeepsPrettyPrintedUserDebugAsOneEntry() = runBlocking {
        val localLog = Files.createTempFile("alv-runtime-parse-", ".log")
        Files.writeString(
            localLog,
            listOf(
                "12:00:00.000 (1)|USER_DEBUG|[7]|DEBUG|{",
                "  \"account\" : {",
                "    \"name\" : \"Acme | Main\"",
                "  }",
                "}",
                "12:00:01.000 (2)|METHOD_EXIT|[7]|Example.run()",
            ).joinToString("\n"),
        )
        val runtime = createApexLogViewerRuntime()
        try {
            assertEquals(
                listOf(
                    ParsedLogEntry(
                        id = 0,
                        timestamp = "12:00:00.000",
                        elapsed = "1",
                        type = "USER_DEBUG",
                        lineNumber = 7,
                        message = "DEBUG | {\n  \"account\" : {\n    \"name\" : \"Acme | Main\"\n  }\n}",
                        raw = Files.readAllLines(localLog).take(5).joinToString("\n"),
                        category = LogCategory.DEBUG,
                    ),
                    ParsedLogEntry(
                        id = 5,
                        timestamp = "12:00:01.000",
                        elapsed = "2",
                        type = "METHOD_EXIT",
                        lineNumber = 7,
                        message = "Example.run()",
                        raw = "12:00:01.000 (2)|METHOD_EXIT|[7]|Example.run()",
                        category = LogCategory.SYSTEM,
                    ),
                ),
                runtime.parseLog(ParseLogRequest(localLog)),
            )
        } finally {
            runtime.close()
            Files.deleteIfExists(localLog)
        }
    }

    fun testParseLogStopsBeforeReturningWhenCancelledDuringStreaming() = runBlocking {
        val localLog = Files.createTempFile("alv-runtime-parse-cancel-", ".log")
        Files.newBufferedWriter(localLog, StandardCharsets.UTF_8).use { writer ->
            repeat(300_000) { index ->
                writer.append("12:00:00.000 ($index)|METHOD_ENTRY|[7]|Example.run()\n")
            }
        }
        val runtime = createApexLogViewerRuntime()
        val started = CompletableDeferred<Unit>()
        val returnedNormally = AtomicBoolean(false)
        try {
            val operation = async(Dispatchers.Default) {
                started.complete(Unit)
                runtime.parseLog(ParseLogRequest(localLog))
                returnedNormally.set(true)
            }
            started.await()
            delay(10)
            operation.cancelAndJoin()

            assertFalse("parseLog returned normally after its job was cancelled", returnedNormally.get())
        } finally {
            runtime.close()
            Files.deleteIfExists(localLog)
        }
    }

    fun testTriageLogStopsBeforeReturningWhenCancelledDuringStreaming() = runBlocking {
        val localLog = Files.createTempFile("alv-runtime-triage-cancel-", ".log")
        val chunk = "ordinary Apex execution text without a diagnostic marker\n".repeat(1_024)
        Files.newBufferedWriter(localLog, StandardCharsets.UTF_8).use { writer ->
            repeat(512) { writer.append(chunk) }
        }
        val runtime = createApexLogViewerRuntime()
        val started = CompletableDeferred<Unit>()
        val returnedNormally = AtomicBoolean(false)
        try {
            val operation = async(Dispatchers.Default) {
                started.complete(Unit)
                runtime.triageLog(ParseLogRequest(localLog))
                returnedNormally.set(true)
            }
            started.await()
            delay(10)
            operation.cancelAndJoin()

            assertFalse("triageLog returned normally after its job was cancelled", returnedNormally.get())
        } finally {
            runtime.close()
            Files.deleteIfExists(localLog)
        }
    }

    fun testLogPageContinuesThroughAStableStartTimeAndIdCursor() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-log-page-")
        val requests = mutableListOf<HttpRequest>()
        val runtime = createApexLogViewerRuntime(
            RuntimeDependencies(
                process = RuntimeProcess {
                    ProcessResponse(
                        0,
                        """{"status":0,"result":{"username":"demo@example.com","instanceUrl":"https://example.my.salesforce.com","accessToken":"test-token","apiVersion":"63.0"}}""",
                        "",
                    )
                },
                http = RuntimeHttp { request ->
                    requests += request
                    HttpResponse(
                        200,
                        emptyMap(),
                        """{"records":[{"Id":"07L000000000031AAA","StartTime":"2026-08-10T17:59:00.000Z","Status":"Success"},{"Id":"07L000000000030AAA","StartTime":"2026-08-10T17:58:00.000Z","Status":"Success"}]}""",
                    )
                },
            ),
        )
        try {
            val page = runtime.logPage(
                LogPageRequest(
                    workspaceRoot = workspaceRoot,
                    username = "demo@example.com",
                    limit = 2,
                    cursor = LogCursor("2026-08-10T18:00:00.000Z", "07L000000000032AAA"),
                ),
            )

            assertEquals(listOf("07L000000000031AAA", "07L000000000030AAA"), page.logs.map { it.id })
            assertEquals(LogCursor("2026-08-10T17:58:00.000Z", "07L000000000030AAA"), page.nextCursor)
            val decodedUrl = URLDecoder.decode(requests.single().url, StandardCharsets.UTF_8)
            assertTrue(decodedUrl.contains("StartTime < 2026-08-10T18:00:00.000Z"))
            assertTrue(decodedUrl.contains("Id < '07L000000000032AAA'"))
        } finally {
            runtime.close()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testLogPageUsesTheRequestedSortForItsStableCursor() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-sorted-log-page-")
        var capturedRequest: HttpRequest? = null
        val runtime = createApexLogViewerRuntime(
            RuntimeDependencies(
                process = RuntimeProcess {
                    ProcessResponse(
                        0,
                        """{"status":0,"result":{"username":"demo@example.com","instanceUrl":"https://example.my.salesforce.com","accessToken":"test-token","apiVersion":"63.0"}}""",
                        "",
                    )
                },
                http = RuntimeHttp { request ->
                    capturedRequest = request
                    HttpResponse(
                        200,
                        emptyMap(),
                        """{"records":[{"Id":"07L000000000011AAA","StartTime":"2026-08-10T17:59:00.000Z"},{"Id":"07L000000000012AAA","StartTime":"2026-08-10T17:58:00.000Z"}]}""",
                    )
                },
            ),
        )
        try {
            val cursor = LogCursor(
                beforeStartTime = "",
                beforeId = "07L000000000010AAA",
                sortValue = "07L000000000010AAA",
                sortField = LogPageSortField.LOG_ID,
                sortDirection = LogPageSortDirection.ASCENDING,
                snapshotMaxStartTime = "2026-08-10T18:00:00Z",
            )
            val page = runtime.logPage(
                LogPageRequest(
                    workspaceRoot = workspaceRoot,
                    username = "demo@example.com",
                    limit = 2,
                    cursor = cursor,
                    sortField = LogPageSortField.LOG_ID,
                    sortDirection = LogPageSortDirection.ASCENDING,
                ),
            )

            val decodedUrl = URLDecoder.decode(requireNotNull(capturedRequest).url, StandardCharsets.UTF_8)
            assertTrue(decodedUrl.contains("WHERE StartTime <= 2026-08-10T18:00:00Z AND Id > '07L000000000010AAA'"))
            assertTrue(decodedUrl.contains("ORDER BY Id ASC LIMIT 2"))
            assertEquals(
                LogCursor(
                    beforeStartTime = "2026-08-10T17:58:00.000Z",
                    beforeId = "07L000000000012AAA",
                    sortValue = "07L000000000012AAA",
                    sortField = LogPageSortField.LOG_ID,
                    sortDirection = LogPageSortDirection.ASCENDING,
                    snapshotMaxStartTime = "2026-08-10T18:00:00Z",
                ),
                page.nextCursor,
            )
        } finally {
            runtime.close()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testNonDefaultLogPagesReuseTheSnapshotWatermarkAcrossInsertions() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-watermarked-log-page-")
        val requests = mutableListOf<String>()
        val watermark = "2026-08-10T18:00:00Z"
        val runtime = createApexLogViewerRuntime(
            RuntimeDependencies(
                process = RuntimeProcess {
                    ProcessResponse(
                        0,
                        """{"status":0,"result":{"username":"demo@example.com","instanceUrl":"https://example.my.salesforce.com","accessToken":"test-token","apiVersion":"63.0"}}""",
                        "",
                    )
                },
                http = RuntimeHttp { request ->
                    val decoded = URLDecoder.decode(request.url, StandardCharsets.UTF_8)
                    requests += decoded
                    val records = if (requests.size == 1) {
                        """[{"Id":"07L000000000011AAA","StartTime":"2026-08-10T17:59:00.000Z"},{"Id":"07L000000000012AAA","StartTime":"2026-08-10T17:58:00.000Z"}]"""
                    } else if (decoded.contains("StartTime <= $watermark")) {
                        """[{"Id":"07L000000000013AAA","StartTime":"2026-08-10T17:57:00.000Z"}]"""
                    } else {
                        """[{"Id":"07L000000000014AAA","StartTime":"2026-08-10T18:01:00.000Z"}]"""
                    }
                    HttpResponse(200, emptyMap(), """{"records":$records}""")
                },
                clock = Clock.fixed(Instant.parse(watermark), ZoneOffset.UTC),
            ),
        )
        try {
            val first = runtime.logPage(
                LogPageRequest(
                    workspaceRoot,
                    "demo@example.com",
                    limit = 2,
                    sortField = LogPageSortField.LOG_ID,
                    sortDirection = LogPageSortDirection.ASCENDING,
                ),
            )
            val second = runtime.logPage(
                LogPageRequest(
                    workspaceRoot,
                    "demo@example.com",
                    limit = 2,
                    cursor = requireNotNull(first.nextCursor),
                    sortField = LogPageSortField.LOG_ID,
                    sortDirection = LogPageSortDirection.ASCENDING,
                ),
            )

            assertEquals(watermark, requireNotNull(first.nextCursor).snapshotMaxStartTime)
            assertTrue(requests[0].contains("WHERE StartTime <= $watermark"))
            assertTrue(requests[1].contains("WHERE StartTime <= $watermark AND Id > '07L000000000012AAA'"))
            assertEquals(listOf("07L000000000013AAA"), second.logs.map(LogListRow::id))
        } finally {
            runtime.close()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testLocalSearchScansOnlyLifecycleBodiesAndReportsPendingLogs() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-search-")
        val firstLogId = "07L000000000011AAA"
        val pendingLogId = "07L000000000012AAA"
        val canonical = workspaceRoot.resolve(
            "apexlogs/orgs/demo@example.com/logs/2026-08-10/$firstLogId.log",
        )
        Files.createDirectories(canonical.parent)
        Files.writeString(canonical, "ignored first line\nprefix NeEdLe suffix\n")
        Files.writeString(workspaceRoot.resolve("unrelated.log"), "needle outside lifecycle")
        val runtime = createApexLogViewerRuntime()
        try {
            val result = runtime.searchLocalLogs(
                LocalLogSearchRequest(
                    workspaceRoot = workspaceRoot,
                    username = "demo@example.com",
                    query = "needle",
                    logs = listOf(
                        LogListRow(firstLogId, startTime = "2026-08-10T18:00:00.000Z", status = "Success"),
                        LogListRow(pendingLogId, startTime = "2026-08-10T18:01:00.000Z", status = "Success"),
                    ),
                ),
            )

            assertEquals(
                LocalLogSearchResult(
                    matches = listOf(
                        LogSearchMatch(
                            logId = firstLogId,
                            source = "body",
                            snippet = "prefix NeEdLe suffix",
                            ranges = listOf(MatchRange(7, 13)),
                        ),
                    ),
                    pendingLogIds = listOf(pendingLogId),
                ),
                result,
            )
        } finally {
            runtime.close()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testLocalSearchMatchesApplicationMetadataWithoutReadingABody() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-application-search-")
        val logId = "07L000000000013AAA"
        val runtime = createApexLogViewerRuntime()
        try {
            val result = runtime.searchLocalLogs(
                LocalLogSearchRequest(
                    workspaceRoot = workspaceRoot,
                    username = "demo@example.com",
                    query = "workbench",
                    logs = listOf(LogListRow(logId, application = "Workbench")),
                ),
            )

            assertEquals(listOf(logId), result.matches.map(LogSearchMatch::logId))
            assertEquals("metadata", result.matches.single().source)
            assertEquals(emptyList<String>(), result.pendingLogIds)
        } finally {
            runtime.close()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testSyncStateUpdateIsBackwardReadableAndPreservesCheckpointOnPartialFailure() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-sync-state-")
        val stateFile = workspaceRoot.resolve("apexlogs/.alv/sync-state.json")
        Files.createDirectories(stateFile.parent)
        Files.writeString(
            stateFile,
            """{"version":2,"futureField":"preserved","orgs":{"other@example.com":{"downloadedCount":7},"demo@example.com":{"lastSyncedLogId":"07L000000000020AAA","lastSyncedStartTime":"2026-08-10T17:00:00.000Z"}}}""",
        )
        val runtime = createApexLogViewerRuntime()
        try {
            runtime.updateSyncState(
                SyncStateUpdateRequest(
                    workspaceRoot = workspaceRoot,
                    username = "demo@example.com",
                    startedAt = "2026-08-11T00:00:00Z",
                    completedAt = "2026-08-11T00:01:00Z",
                    newestLog = LogListRow("07L000000000021AAA", "2026-08-10T18:00:00.000Z"),
                    existingCount = 2,
                    materializedCount = 1,
                    downloadedCount = 3,
                    failedCount = 0,
                ),
            )
            runtime.updateSyncState(
                SyncStateUpdateRequest(
                    workspaceRoot = workspaceRoot,
                    username = "demo@example.com",
                    startedAt = "2026-08-11T00:02:00Z",
                    completedAt = "2026-08-11T00:03:00Z",
                    newestLog = LogListRow("07L000000000022AAA", "2026-08-10T19:00:00.000Z"),
                    existingCount = 4,
                    materializedCount = 0,
                    downloadedCount = 1,
                    failedCount = 1,
                ),
            )

            val root = JsonParser.parseString(Files.readString(stateFile)).asJsonObject
            val demo = root.getAsJsonObject("orgs").getAsJsonObject("demo@example.com")
            assertEquals(2, root.get("version").asInt)
            assertEquals("preserved", root.get("futureField").asString)
            assertEquals(7, root.getAsJsonObject("orgs").getAsJsonObject("other@example.com").get("downloadedCount").asInt)
            assertEquals("07L000000000021AAA", demo.get("lastSyncedLogId").asString)
            assertEquals("2026-08-10T18:00:00.000Z", demo.get("lastSyncedStartTime").asString)
            assertEquals(4, demo.get("existingCount").asInt)
            assertEquals(1, demo.get("downloadedCount").asInt)
            assertEquals(1, demo.get("failedCount").asInt)
            assertEquals("1\n", Files.readString(stateFile.resolveSibling("version.json")))
        } finally {
            runtime.close()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testConcurrentSyncStateUpdatesInitializeOneCompatibleLifecycleVersionMarker() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-sync-version-concurrent-")
        val first = createApexLogViewerRuntime()
        val second = createApexLogViewerRuntime()
        try {
            listOf(
                async(Dispatchers.Default) { first.updateSyncState(syncStateRequest(workspaceRoot, "first@example.com")) },
                async(Dispatchers.Default) { second.updateSyncState(syncStateRequest(workspaceRoot, "second@example.com")) },
            ).awaitAll()

            val versionFile = workspaceRoot.resolve("apexlogs/.alv/version.json")
            assertEquals("1\n", Files.readString(versionFile))
            val state = JsonParser.parseString(Files.readString(versionFile.resolveSibling("sync-state.json"))).asJsonObject
            assertEquals(setOf("first@example.com", "second@example.com"), state.getAsJsonObject("orgs").keySet())
        } finally {
            first.close()
            second.close()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testSyncStateUpdateAcceptsAnyJsonNumericRepresentationOfLifecycleVersionOne() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-sync-version-numeric-")
        val versionFile = workspaceRoot.resolve("apexlogs/.alv/version.json")
        Files.createDirectories(versionFile.parent)
        Files.writeString(versionFile, "1.0e0\n")
        val runtime = createApexLogViewerRuntime()
        try {
            runtime.updateSyncState(syncStateRequest(workspaceRoot, "numeric@example.com"))
            assertEquals("1.0e0\n", Files.readString(versionFile))
            assertTrue(Files.isRegularFile(versionFile.resolveSibling("sync-state.json")))
        } finally {
            runtime.close()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testSyncStateUpdateRejectsIncompatibleOrCorruptLifecycleVersionBeforeMutatingState() = runBlocking {
        listOf("2\n", "{not-json").forEachIndexed { index, version ->
            val workspaceRoot = Files.createTempDirectory("alv-runtime-sync-version-rejected-$index-")
            val stateFile = workspaceRoot.resolve("apexlogs/.alv/sync-state.json")
            val versionFile = stateFile.resolveSibling("version.json")
            val originalState = """{"version":1,"sentinel":"unchanged","orgs":{}}"""
            Files.createDirectories(stateFile.parent)
            Files.writeString(stateFile, originalState)
            Files.writeString(versionFile, version)
            val runtime = createApexLogViewerRuntime()
            try {
                val failure = captureFailure {
                    runtime.updateSyncState(syncStateRequest(workspaceRoot, "rejected@example.com"))
                }
                assertEquals("local-persistence", failure.code)
                assertEquals(originalState, Files.readString(stateFile))
                assertEquals(version, Files.readString(versionFile))
            } finally {
                runtime.close()
                deleteRecursively(workspaceRoot)
            }
        }
    }

    fun testSyncStateUpdateWaitsForAnActiveCrossProcessLock() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-sync-lock-contention-")
        val lockFile = workspaceRoot.resolve("apexlogs/.alv/sync-state.lock")
        Files.createDirectories(lockFile.parent)
        Files.writeString(lockFile, "external-owner")
        val runtime = createApexLogViewerRuntime()
        try {
            val update = async(Dispatchers.Default) {
                runtime.updateSyncState(
                    SyncStateUpdateRequest(
                        workspaceRoot,
                        "demo@example.com",
                        "2026-08-11T00:00:00Z",
                        "2026-08-11T00:01:00Z",
                        null,
                        existingCount = 1,
                        materializedCount = 0,
                        downloadedCount = 0,
                        failedCount = 0,
                    ),
                )
            }
            delay(250)
            assertTrue("sync update should wait while another owner holds the lock", update.isActive)
            assertFalse(Files.exists(workspaceRoot.resolve("apexlogs/.alv/sync-state.json")))

            Files.delete(lockFile)
            withTimeout(5_000) { update.await() }
            assertFalse(Files.exists(lockFile))
            assertTrue(Files.isRegularFile(workspaceRoot.resolve("apexlogs/.alv/sync-state.json")))
        } finally {
            runtime.close()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testOlderSuccessfulSyncStateWriterCannotRegressANewerSharedCheckpoint() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-sync-monotonic-")
        val stateFile = workspaceRoot.resolve("apexlogs/.alv/sync-state.json")
        val lockFile = stateFile.resolveSibling("sync-state.lock")
        Files.createDirectories(stateFile.parent)
        Files.writeString(lockFile, "newer-writer")
        val runtime = createApexLogViewerRuntime()
        try {
            val olderUpdate = async(Dispatchers.Default) {
                runtime.updateSyncState(
                    SyncStateUpdateRequest(
                        workspaceRoot,
                        "demo@example.com",
                        "2026-08-11T00:00:00Z",
                        "2026-08-11T00:01:00Z",
                        LogListRow("07L000000000099AAA", "2026-08-10T18:00:00.000Z"),
                        existingCount = 2,
                        materializedCount = 1,
                        downloadedCount = 0,
                        failedCount = 0,
                    ),
                )
            }
            delay(250)
            assertTrue("the older writer should still be waiting for the shared lock", olderUpdate.isActive)
            Files.writeString(
                stateFile,
                """{"version":1,"futureField":"preserved","orgs":{"other@example.com":{"customOtherField":true},"demo@example.com":{"lastSyncedLogId":"07L000000000020AAA","lastSyncedStartTime":"2026-08-10T19:00:00.000Z","customOrgField":"preserved"}}}""",
            )
            Files.delete(lockFile)
            withTimeout(5_000) { olderUpdate.await() }

            runtime.updateSyncState(
                SyncStateUpdateRequest(
                    workspaceRoot,
                    "demo@example.com",
                    "2026-08-11T00:02:00Z",
                    "2026-08-11T00:03:00Z",
                    LogListRow("07L000000000019AAA", "2026-08-10T19:00:00.000Z"),
                    existingCount = 3,
                    materializedCount = 0,
                    downloadedCount = 1,
                    failedCount = 0,
                ),
            )

            val root = JsonParser.parseString(Files.readString(stateFile)).asJsonObject
            val orgs = root.getAsJsonObject("orgs")
            val demo = orgs.getAsJsonObject("demo@example.com")
            assertEquals("07L000000000020AAA", demo.get("lastSyncedLogId").asString)
            assertEquals("2026-08-10T19:00:00.000Z", demo.get("lastSyncedStartTime").asString)
            assertEquals("preserved", root.get("futureField").asString)
            assertEquals("preserved", demo.get("customOrgField").asString)
            assertTrue(orgs.getAsJsonObject("other@example.com").get("customOtherField").asBoolean)
            assertEquals(3, demo.get("existingCount").asInt)
            assertEquals(1, demo.get("downloadedCount").asInt)
        } finally {
            runtime.close()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testSyncStateLockWaitIsCancellable() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-sync-lock-cancel-")
        val lockFile = workspaceRoot.resolve("apexlogs/.alv/sync-state.lock")
        Files.createDirectories(lockFile.parent)
        Files.writeString(lockFile, "external-owner")
        val runtime = createApexLogViewerRuntime()
        try {
            val update = async(Dispatchers.Default) {
                runtime.updateSyncState(
                    SyncStateUpdateRequest(
                        workspaceRoot,
                        "demo@example.com",
                        "2026-08-11T00:00:00Z",
                        "2026-08-11T00:01:00Z",
                        null,
                        existingCount = 1,
                        materializedCount = 0,
                        downloadedCount = 0,
                        failedCount = 0,
                    ),
                )
            }
            delay(250)
            update.cancelAndJoin()

            assertEquals("external-owner", Files.readString(lockFile))
            assertFalse(Files.exists(workspaceRoot.resolve("apexlogs/.alv/sync-state.json")))
        } finally {
            runtime.close()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testSyncStateUpdateRejectsANonRegularSharedLock() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-sync-lock-directory-")
        val lockFile = workspaceRoot.resolve("apexlogs/.alv/sync-state.lock")
        Files.createDirectories(lockFile)
        val runtime = createApexLogViewerRuntime()
        try {
            val failure = runCatching {
                withTimeout(1_000) {
                    runtime.updateSyncState(
                        SyncStateUpdateRequest(
                            workspaceRoot,
                            "demo@example.com",
                            "2026-08-11T00:00:00Z",
                            "2026-08-11T00:01:00Z",
                            null,
                            existingCount = 1,
                            materializedCount = 0,
                            downloadedCount = 0,
                            failedCount = 0,
                        ),
                    )
                }
            }.exceptionOrNull()

            assertTrue(failure is ApexLogViewerRuntimeException)
            assertEquals("local-persistence", (failure as ApexLogViewerRuntimeException).code)
            assertTrue(Files.isDirectory(lockFile))
        } finally {
            runtime.close()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testSyncStateUpdateUsesABoundedSharedLockWait() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-sync-lock-timeout-")
        val lockFile = workspaceRoot.resolve("apexlogs/.alv/sync-state.lock")
        Files.createDirectories(lockFile.parent)
        Files.writeString(lockFile, "active-owner")
        val runtime = createApexLogViewerRuntime(
            RuntimeDependencies(
                process = RuntimeProcess { error("process must not run") },
                http = RuntimeHttp { error("HTTP must not run") },
            ),
            syncStateLockWaitTimeout = Duration.ZERO,
        )
        try {
            val failure = runCatching {
                runtime.updateSyncState(
                    SyncStateUpdateRequest(
                        workspaceRoot,
                        "demo@example.com",
                        "2026-08-11T00:00:00Z",
                        "2026-08-11T00:01:00Z",
                        null,
                        existingCount = 1,
                        materializedCount = 0,
                        downloadedCount = 0,
                        failedCount = 0,
                    ),
                )
            }.exceptionOrNull()

            assertTrue(failure is ApexLogViewerRuntimeException)
            assertEquals("local-persistence", (failure as ApexLogViewerRuntimeException).code)
            assertEquals("active-owner", Files.readString(lockFile))
        } finally {
            runtime.close()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testSyncStateUpdateReclaimsOnlyAStaleRegularLock() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-sync-lock-stale-")
        val lockFile = workspaceRoot.resolve("apexlogs/.alv/sync-state.lock")
        val deadPid = provenDeadPid()
        Files.createDirectories(lockFile.parent)
        Files.writeString(
            lockFile,
            """{"version":1,"pid":$deadPid,"token":"00000000-0000-0000-0000-000000000001"}""",
        )
        Files.setLastModifiedTime(lockFile, FileTime.from(Instant.now().minusSeconds(121)))
        val runtime = createApexLogViewerRuntime()
        try {
            withTimeout(5_000) {
                runtime.updateSyncState(
                    SyncStateUpdateRequest(
                        workspaceRoot,
                        "demo@example.com",
                        "2026-08-11T00:00:00Z",
                        "2026-08-11T00:01:00Z",
                        null,
                        existingCount = 1,
                        materializedCount = 0,
                        downloadedCount = 0,
                        failedCount = 0,
                    ),
                )
            }

            assertFalse(Files.exists(lockFile))
            assertTrue(Files.isRegularFile(workspaceRoot.resolve("apexlogs/.alv/sync-state.json")))
        } finally {
            runtime.close()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testSyncStateUpdateNeverReclaimsStaleLiveOrUnrecognizedLocks() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-sync-lock-fail-closed-")
        val lockFile = workspaceRoot.resolve("apexlogs/.alv/sync-state.lock")
        Files.createDirectories(lockFile.parent)
        val lockPayloads = listOf(
            """{"version":1,"pid":${ProcessHandle.current().pid()},"token":"00000000-0000-0000-0000-000000000002"}""",
            "legacy-owner-token",
            """{"version":1,"pid":"unreadable","token":"not-a-uuid"}""",
        )
        val runtime = createApexLogViewerRuntime(
            RuntimeDependencies(
                process = RuntimeProcess { error("process must not run") },
                http = RuntimeHttp { error("HTTP must not run") },
            ),
            syncStateLockWaitTimeout = Duration.ZERO,
        )
        try {
            lockPayloads.forEach { payload ->
                Files.writeString(lockFile, payload)
                Files.setLastModifiedTime(lockFile, FileTime.from(Instant.now().minusSeconds(121)))

                val failure = runCatching {
                    runtime.updateSyncState(
                        SyncStateUpdateRequest(
                            workspaceRoot,
                            "demo@example.com",
                            "2026-08-11T00:00:00Z",
                            "2026-08-11T00:01:00Z",
                            null,
                            existingCount = 1,
                            materializedCount = 0,
                            downloadedCount = 0,
                            failedCount = 0,
                        ),
                    )
                }.exceptionOrNull()

                assertTrue("expected fail-closed lock timeout for $payload but got $failure", failure is ApexLogViewerRuntimeException)
                assertEquals(payload, Files.readString(lockFile))
            }
        } finally {
            runtime.close()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testSyncStateUpdateDoesNotRaceAnExistingStaleLockReclaimer() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-sync-lock-reclaimer-")
        val lockFile = workspaceRoot.resolve("apexlogs/.alv/sync-state.lock")
        val deadPid = provenDeadPid()
        val token = "00000000-0000-0000-0000-000000000003"
        val payload = """{"version":1,"pid":$deadPid,"token":"$token"}"""
        val marker = lockFile.resolveSibling("sync-state.lock.reclaim-$token")
        Files.createDirectories(lockFile.parent)
        Files.writeString(lockFile, payload)
        Files.writeString(marker, payload)
        Files.setLastModifiedTime(lockFile, FileTime.from(Instant.now().minusSeconds(121)))
        val runtime = createApexLogViewerRuntime(
            RuntimeDependencies(
                process = RuntimeProcess { error("process must not run") },
                http = RuntimeHttp { error("HTTP must not run") },
            ),
            syncStateLockWaitTimeout = Duration.ZERO,
        )
        try {
            val failure = runCatching {
                runtime.updateSyncState(
                    SyncStateUpdateRequest(
                        workspaceRoot,
                        "demo@example.com",
                        "2026-08-11T00:00:00Z",
                        "2026-08-11T00:01:00Z",
                        null,
                        existingCount = 1,
                        materializedCount = 0,
                        downloadedCount = 0,
                        failedCount = 0,
                    ),
                )
            }.exceptionOrNull()

            assertTrue(failure is ApexLogViewerRuntimeException)
            assertEquals(payload, Files.readString(lockFile))
            assertEquals(payload, Files.readString(marker))
        } finally {
            runtime.close()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testConcurrentSyncStateUpdatesDoNotReclaimTheNewOwnerAfterADeadOwner() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-sync-lock-dead-owner-race-")
        val lockFile = workspaceRoot.resolve("apexlogs/.alv/sync-state.lock")
        val deadPid = provenDeadPid()
        val deadToken = "00000000-0000-0000-0000-000000000004"
        val deadPayload = """{"version":1,"pid":$deadPid,"token":"$deadToken"}"""
        Files.createDirectories(lockFile.parent)
        Files.writeString(lockFile, deadPayload)
        Files.setLastModifiedTime(lockFile, FileTime.from(Instant.now().minusSeconds(121)))
        val runtimes = List(2) { createApexLogViewerRuntime() }
        try {
            listOf("first@example.com", "second@example.com").mapIndexed { index, username ->
                async(Dispatchers.Default) {
                    runtimes[index].updateSyncState(
                        SyncStateUpdateRequest(
                            workspaceRoot,
                            username,
                            "2026-08-11T00:00:00Z",
                            "2026-08-11T00:01:00Z",
                            null,
                            existingCount = index + 1,
                            materializedCount = 0,
                            downloadedCount = 0,
                            failedCount = 0,
                        ),
                    )
                }
            }.awaitAll()

            val orgs = JsonParser.parseString(
                Files.readString(workspaceRoot.resolve("apexlogs/.alv/sync-state.json")),
            ).asJsonObject.getAsJsonObject("orgs")
            assertEquals(setOf("first@example.com", "second@example.com"), orgs.keySet())
            assertFalse(Files.exists(lockFile))
            assertEquals(
                deadPayload,
                Files.readString(lockFile.resolveSibling("sync-state.lock.reclaim-$deadToken")),
            )
        } finally {
            runtimes.forEach(ApexLogViewerRuntime::close)
            deleteRecursively(workspaceRoot)
        }
    }

    fun testRequireLocalLogMaterializesTheRemoteBodyInCanonicalStorage() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-materialize-")
        val processRequests = mutableListOf<ProcessRequest>()
        val runtime = createApexLogViewerRuntime(
            RuntimeDependencies(
                process = RuntimeProcess { request ->
                    processRequests += request
                    when (request.arguments.take(3)) {
                        listOf("org", "display", "--target-org") -> ProcessResponse(
                            exitCode = 0,
                            stdout =
                                """NOTE: This error can be ignored in CI and may be silenced in the future
                                |{"status":0,"result":{"username":"resolved@example.com","alias":"demo","instanceUrl":"https://example.my.salesforce.com","accessToken":"[REDACTED] Use 'sf org auth show-access-token' to view","apiVersion":"63.0"}}""".trimMargin(),
                            stderr = "",
                        )
                        listOf("org", "auth", "show-access-token") -> ProcessResponse(
                            exitCode = 0,
                            stdout = """{"status":0,"result":{"accessToken":"test-token"}}""",
                            stderr = "",
                        )
                        else -> error("unexpected Salesforce CLI request: ${request.arguments}")
                    }
                },
                http = RuntimeHttp { request ->
                    assertEquals(
                        "https://example.my.salesforce.com/services/data/v63.0/tooling/sobjects/ApexLog/07L000000000003AAA/Body",
                        request.url,
                    )
                    assertEquals("Bearer test-token", request.headers["Authorization"])
                    HttpResponse(200, emptyMap(), "remote body")
                },
            ),
        )
        try {
            val result = runtime.requireLocalLog(
                RequireLocalLogRequest(
                    workspaceRoot = workspaceRoot,
                    targetOrg = "demo",
                    log = LogListRow(
                        id = "07L000000000003AAA",
                        startTime = "2026-07-20T14:30:00.000Z",
                    ),
                ),
            )

            val expectedPath = workspaceRoot.resolve(
                "apexlogs/orgs/resolved@example.com/logs/2026-07-20/07L000000000003AAA.log",
            )
            assertEquals(
                LocalLogFile(
                    logId = "07L000000000003AAA",
                    startTime = "2026-07-20T14:30:00.000Z",
                    resolvedUsername = "resolved@example.com",
                    source = "remote",
                    persistence = "written",
                    localPath = expectedPath,
                ),
                result,
            )
            assertEquals("remote body", Files.readString(expectedPath))
            assertEquals("apexlogs/\n", Files.readString(workspaceRoot.resolve(".gitignore")))
            assertFalse(Files.readString(workspaceRoot.resolve("apexlogs/orgs/resolved@example.com/org.json")).contains("test-token"))
            assertEquals(
                listOf("07L000000000003AAA.log"),
                Files.list(expectedPath.parent).use { paths -> paths.map { it.fileName.toString() }.sorted().toList() },
            )
            assertEquals(
                listOf(
                    listOf("org", "display", "--target-org", "demo", "--json"),
                    listOf("org", "auth", "show-access-token", "--target-org", "demo", "--json"),
                ),
                processRequests.map(ProcessRequest::arguments),
            )
            assertTrue(processRequests.all { it.environment == salesforceTestEnvironment })
        } finally {
            runtime.close()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testRedactedCliTokenWithInvalidShowAccessTokenResponseNeverReachesHttp() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-redacted-token-")
        var processCalls = 0
        var httpCalls = 0
        val runtime = createApexLogViewerRuntime(
            RuntimeDependencies(
                process = RuntimeProcess { request ->
                    processCalls += 1
                    when (request.arguments.take(3)) {
                        listOf("org", "display", "--target-org") -> ProcessResponse(
                            0,
                            """{"status":0,"result":{"username":"demo@example.com","instanceUrl":"https://example.my.salesforce.com","accessToken":"[REDACTED] Use 'sf org auth show-access-token' to view","apiVersion":"63.0"}}""",
                            "",
                        )
                        listOf("org", "auth", "show-access-token") -> ProcessResponse(
                            0,
                            """{"status":0,"result":{}}""",
                            "",
                        )
                        else -> error("unexpected Salesforce CLI request: ${request.arguments}")
                    }
                },
                http = RuntimeHttp {
                    httpCalls += 1
                    error("a redacted token must never reach HTTP")
                },
            ),
        )
        try {
            val failure = captureFailure {
                runtime.logList(LogListRequest(workspaceRoot, "demo@example.com", 2))
            }
            assertEquals("org-resolution", failure.code)
            assertEquals(2, processCalls)
            assertEquals(0, httpCalls)
        } finally {
            runtime.close()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testRedactedCliTokenVariantsAlwaysUseShowAccessToken() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-redacted-variants-")
        val redactedVariants = listOf(
            "REDACTED",
            "[redacted]",
            "Use 'sf org auth show-access-token' to view",
        )
        try {
            redactedVariants.forEach { displayedToken ->
                var processCalls = 0
                val runtime = createApexLogViewerRuntime(
                    RuntimeDependencies(
                        process = RuntimeProcess { request ->
                            processCalls += 1
                            when (request.arguments.take(3)) {
                                listOf("org", "display", "--target-org") -> ProcessResponse(
                                    0,
                                    """{"status":0,"result":{"username":"demo@example.com","instanceUrl":"https://example.my.salesforce.com","accessToken":"$displayedToken","apiVersion":"63.0"}}""",
                                    "",
                                )
                                listOf("org", "auth", "show-access-token") -> ProcessResponse(
                                    0,
                                    """{"status":0,"result":{"accessToken":"resolved-token"}}""",
                                    "",
                                )
                                else -> error("unexpected Salesforce CLI request: ${request.arguments}")
                            }
                        },
                        http = RuntimeHttp { request ->
                            assertEquals("Bearer resolved-token", request.headers["Authorization"])
                            HttpResponse(200, emptyMap(), """{"records":[]}""")
                        },
                    ),
                )
                try {
                    assertEquals(
                        emptyList<LogListRow>(),
                        runtime.logList(LogListRequest(workspaceRoot, "demo@example.com", 2)),
                    )
                    assertEquals(2, processCalls)
                } finally {
                    runtime.close()
                }
            }
        } finally {
            deleteRecursively(workspaceRoot)
        }
    }

    fun testShowAccessTokenRejectsRedactedVariantBeforeHttp() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-redacted-fallback-")
        var httpCalls = 0
        val runtime = createApexLogViewerRuntime(
            RuntimeDependencies(
                process = RuntimeProcess { request ->
                    when (request.arguments.take(3)) {
                        listOf("org", "display", "--target-org") -> ProcessResponse(
                            0,
                            """{"status":0,"result":{"username":"demo@example.com","instanceUrl":"https://example.my.salesforce.com","accessToken":"[REDACTED]","apiVersion":"63.0"}}""",
                            "",
                        )
                        listOf("org", "auth", "show-access-token") -> ProcessResponse(
                            0,
                            """{"status":0,"result":{"accessToken":"REDACTED"}}""",
                            "",
                        )
                        else -> error("unexpected Salesforce CLI request: ${request.arguments}")
                    }
                },
                http = RuntimeHttp {
                    httpCalls += 1
                    error("a redacted fallback token must never reach HTTP")
                },
            ),
        )
        try {
            val failure = captureFailure {
                runtime.logList(LogListRequest(workspaceRoot, "demo@example.com", 2))
            }
            assertEquals("org-resolution", failure.code)
            assertEquals(0, httpCalls)
        } finally {
            runtime.close()
            deleteRecursively(workspaceRoot)
        }
    }

    fun testOrgListNormalizesDuplicatesAndPrefersTheCliDefault() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-org-list-")
        val requests = mutableListOf<ProcessRequest>()
        val runtime = createApexLogViewerRuntime(
            RuntimeDependencies(
                process = RuntimeProcess { request ->
                    requests += request
                    ProcessResponse(
                        exitCode = 0,
                        stdout =
                            """NOTE: This error can be ignored in CI and may be silenced in the future
                            |{"status":0,"result":{"nonScratchOrgs":[{"username":"zulu@example.com","alias":"Zulu","instanceUrl":"https://zulu.example.com"},{"username":"default@example.com","alias":"Default","isDefaultUsername":true}],"scratchOrgs":[{"username":"alpha@example.com","alias":"Alpha","isScratchOrg":true},{"username":"default@example.com","alias":"Duplicate"}]}}""".trimMargin(),
                        stderr = "",
                    )
                },
                http = RuntimeHttp { error("HTTP must not run") },
            ),
        )
        try {
            val orgs = runtime.orgList(OrgListRequest(workspaceRoot))

            assertEquals(
                listOf(
                    OrgListItem("default@example.com", "Default", isDefaultUsername = true),
                    OrgListItem("alpha@example.com", "Alpha", isScratchOrg = true),
                    OrgListItem("zulu@example.com", "Zulu", instanceUrl = "https://zulu.example.com"),
                ),
                orgs,
            )
            assertEquals(
                listOf(
                    ProcessRequest(
                        "sf",
                        listOf("org", "list", "--json"),
                        workspaceRoot,
                        salesforceTestEnvironment,
                    ),
                ),
                requests,
            )
        } finally {
            runtime.close()
            deleteRecursively(workspaceRoot)
        }
    }

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

    fun testInvalidCliConnectionDataNeverReachesBearerHttp() = runBlocking {
        val workspaceRoot = Files.createTempDirectory("alv-runtime-invalid-connection-")
        val invalidConnections = listOf(
            "http://example.my.salesforce.com" to "63.0",
            "https://user@example.my.salesforce.com" to "63.0",
            "https://example.my.salesforce.com?redirect=evil" to "63.0",
            "https://example.my.salesforce.com#fragment" to "63.0",
            "https://example.my.salesforce.com/services" to "63.0",
            "https://example.my.salesforce.com" to "v63.0",
            "https://example.my.salesforce.com" to "63",
        )
        try {
            invalidConnections.forEach { (instanceUrl, apiVersion) ->
                var httpCalls = 0
                val runtime = createApexLogViewerRuntime(
                    RuntimeDependencies(
                        process = RuntimeProcess {
                            ProcessResponse(
                                0,
                                """{"status":0,"result":{"username":"demo@example.com","instanceUrl":"$instanceUrl","accessToken":"test-token","apiVersion":"$apiVersion"}}""",
                                "",
                            )
                        },
                        http = RuntimeHttp {
                            httpCalls += 1
                            error("invalid CLI connection data must not reach HTTP")
                        },
                    ),
                )
                try {
                    val failure = captureFailure {
                        runtime.logList(LogListRequest(workspaceRoot, "demo@example.com", 2))
                    }
                    assertEquals("org-resolution", failure.code)
                    assertEquals(0, httpCalls)
                } finally {
                    runtime.close()
                }
            }
        } finally {
            deleteRecursively(workspaceRoot)
        }
    }

    fun testExternalLogRecognitionIsBoundedByMarkersLinesAndBytes() {
        val root = Files.createTempDirectory("alv-runtime-recognition-")
        val valid = root.resolve("valid.log")
        val versionPrefixed = root.resolve("version-prefixed.log")
        val invalid = root.resolve("invalid.log")
        val eleventhLine = root.resolve("eleventh.log")
        val beyondLimit = root.resolve("beyond-limit.log")
        try {
            Files.writeString(valid, "header\n12:00:00.000 (1)|EXECUTION_STARTED|\n")
            Files.writeString(versionPrefixed, "62.0 APEX_CODE,FINEST\n")
            Files.writeString(invalid, "ordinary text\n")
            Files.writeString(eleventhLine, (1..10).joinToString("\n") { "ordinary $it" } + "\nAPEX_CODE,FINEST\n")
            Files.writeString(beyondLimit, "x".repeat(64 * 1024) + "\nAPEX_CODE,FINEST\n")

            assertTrue(hasBoundedApexLogMarker(valid))
            assertTrue(hasBoundedApexLogMarker(versionPrefixed))
            assertFalse(hasBoundedApexLogMarker(invalid))
            assertFalse(hasBoundedApexLogMarker(eleventhLine))
            assertFalse(hasBoundedApexLogMarker(beyondLimit))
        } finally {
            deleteRecursively(root)
        }
    }

    private suspend fun captureFailure(operation: suspend () -> Unit): ApexLogViewerRuntimeException {
        val failure = runCatching { operation() }.exceptionOrNull()
        assertTrue("expected ApexLogViewerRuntimeException but got $failure", failure is ApexLogViewerRuntimeException)
        return failure as ApexLogViewerRuntimeException
    }

    private fun syncStateRequest(workspaceRoot: Path, username: String) = SyncStateUpdateRequest(
        workspaceRoot = workspaceRoot,
        username = username,
        startedAt = "2026-08-11T00:00:00Z",
        completedAt = "2026-08-11T00:01:00Z",
        newestLog = null,
        existingCount = 0,
        materializedCount = 0,
        downloadedCount = 0,
        failedCount = 0,
    )

    private fun provenDeadPid(): Long = generateSequence(Long.MAX_VALUE) { candidate -> candidate - 1 }
        .first { candidate -> runCatching { ProcessHandle.of(candidate).isEmpty }.getOrDefault(false) }

    private fun createDirectoryLink(link: Path, target: Path) {
        if (System.getProperty("os.name").startsWith("Windows", ignoreCase = true)) {
            val command = "mklink /J \"$link\" \"$target\""
            val process = ProcessBuilder("cmd.exe", "/d", "/s", "/c", command)
                .redirectErrorStream(true)
                .start()
            val output = process.inputStream.bufferedReader().use { it.readText() }
            check(process.waitFor() == 0) { "Could not create test junction: $output" }
        } else {
            Files.createSymbolicLink(link, target)
        }
    }

    private fun deleteRecursively(root: Path) {
        Files.walk(root).use { paths -> paths.sorted(Comparator.reverseOrder()).forEach(Files::deleteIfExists) }
    }
}
