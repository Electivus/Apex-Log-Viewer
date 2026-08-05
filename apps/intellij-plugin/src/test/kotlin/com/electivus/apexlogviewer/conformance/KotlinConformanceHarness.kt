package com.electivus.apexlogviewer.conformance

import com.electivus.apexlogviewer.runtime.ApexLogViewerRuntimeException
import com.electivus.apexlogviewer.runtime.HttpRequest
import com.electivus.apexlogviewer.runtime.HttpResponse
import com.electivus.apexlogviewer.runtime.LogListRequest
import com.electivus.apexlogviewer.runtime.LogListRow
import com.electivus.apexlogviewer.runtime.LogStatusRequest
import com.electivus.apexlogviewer.runtime.LogStatusResult
import com.electivus.apexlogviewer.runtime.ProcessRequest
import com.electivus.apexlogviewer.runtime.ProcessResponse
import com.electivus.apexlogviewer.runtime.RuntimeDependencies
import com.electivus.apexlogviewer.runtime.RuntimeHttp
import com.electivus.apexlogviewer.runtime.RuntimeProcess
import com.electivus.apexlogviewer.runtime.createApexLogViewerRuntime
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.gson.JsonPrimitive
import junit.framework.TestCase.assertEquals
import junit.framework.TestCase.assertTrue
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.util.Comparator
import kotlin.io.path.invariantSeparatorsPathString

internal object KotlinConformanceHarness {
    private const val WORKSPACE_TOKEN = "<workspace>"

    suspend fun runV1Corpus() {
        val corpusRoot = Path.of(requireNotNull(System.getProperty("alv.conformance.root"))).resolve("v1")
        val schema = parseJson(corpusRoot.resolve("schemas/scenario.schema.json")).asJsonObject
        assertEquals("https://electivus.dev/apex-log-viewer/conformance/v1/scenario.schema.json", schema["\$id"].asString)

        val scenarios = Files.list(corpusRoot.resolve("scenarios")).use { paths ->
            paths.filter { it.fileName.toString().endsWith(".json") }.sorted().toList()
        }
        assertTrue("the v1 conformance corpus must contain scenarios", scenarios.isNotEmpty())
        for (scenarioPath in scenarios) {
            executeScenario(parseJson(scenarioPath).asJsonObject)
        }
    }

    private suspend fun executeScenario(scenario: JsonObject) {
        assertEquals("1.0", scenario["schemaVersion"].asString)
        val id = scenario["id"].asString
        val workspaceRoot = Files.createTempDirectory("alv-conformance-kotlin-$id-")
        try {
            val workspace = scenario["workspace"].asJsonObject
            writeWorkspace(workspaceRoot, workspace["before"].asJsonArray)
            val doubles = replaceWorkspaceToken(scenario["doubles"], workspaceRoot).asJsonObject
            val processDouble = ScriptedProcessDouble(doubles["process"].asJsonArray)
            val httpDouble = ScriptedHttpDouble(doubles["http"].asJsonArray)
            val runtime = createApexLogViewerRuntime(RuntimeDependencies(processDouble, httpDouble))

            val outcome = try {
                when (val operation = scenario["operation"].asString) {
                    "log.status" -> successOutcome(runtime.logStatus(statusRequest(scenario["request"].asJsonObject, workspaceRoot)), workspaceRoot)
                    "log.list" -> successOutcome(runtime.logList(logListRequest(scenario["request"].asJsonObject, workspaceRoot)), workspaceRoot)
                    else -> error("unsupported Kotlin conformance operation: $operation")
                }
            } catch (failure: ApexLogViewerRuntimeException) {
                failureOutcome(
                    failure,
                    scenario["expected"].asJsonObject.getAsJsonObject("failure")?.has("message") == true,
                )
            } finally {
                runtime.close()
                processDouble.assertSatisfied()
                httpDouble.assertSatisfied()
            }

            assertEquals(scenario["description"].asString, scenario["expected"], outcome)
            assertEquals("$id workspace effects", workspace["after"], readWorkspace(workspaceRoot))
        } finally {
            deleteRecursively(workspaceRoot)
        }
    }

    private fun statusRequest(request: JsonObject, workspaceRoot: Path): LogStatusRequest =
        LogStatusRequest(
            workspaceRoot = Path.of(request["workspaceRoot"].asString.replace(WORKSPACE_TOKEN, workspaceRoot.toString())),
            targetOrg = request.get("targetOrg")?.asString,
        )

    private fun logListRequest(request: JsonObject, workspaceRoot: Path): LogListRequest =
        LogListRequest(
            workspaceRoot = Path.of(request["workspaceRoot"].asString.replace(WORKSPACE_TOKEN, workspaceRoot.toString())),
            username = request["username"].asString,
            limit = request.get("limit")?.asInt ?: 50,
        )

    private fun successOutcome(result: LogStatusResult, workspaceRoot: Path): JsonObject =
        JsonObject().apply {
            add(
                "result",
                JsonObject().apply {
                    addProperty("targetOrg", result.targetOrg)
                    addProperty("safeTargetOrg", result.safeTargetOrg)
                    addProperty("workspaceRoot", normalizeWorkspacePath(result.workspaceRoot, workspaceRoot))
                    addProperty("apexlogsRoot", normalizeWorkspacePath(result.apexlogsRoot, workspaceRoot))
                    addProperty("stateFile", normalizeWorkspacePath(result.stateFile, workspaceRoot))
                    addProperty("logCount", result.logCount)
                    addProperty("hasState", result.hasState)
                    result.lastSyncStartedAt?.let { addProperty("lastSyncStartedAt", it) }
                    result.lastSyncCompletedAt?.let { addProperty("lastSyncCompletedAt", it) }
                    result.lastSyncedLogId?.let { addProperty("lastSyncedLogId", it) }
                    result.lastSyncedStartTime?.let { addProperty("lastSyncedStartTime", it) }
                    addProperty("downloadedCount", result.downloadedCount)
                    addProperty("cachedCount", result.cachedCount)
                },
            )
        }

    private fun successOutcome(result: List<LogListRow>, workspaceRoot: Path): JsonObject =
        JsonObject().apply {
            add(
                "result",
                JsonArray().apply {
                    result.forEach { row ->
                        add(
                            JsonObject().apply {
                                addProperty("id", row.id)
                                row.startTime?.let { addProperty("startTime", it) }
                                row.operation?.let { addProperty("operation", normalizeWorkspacePath(it, workspaceRoot)) }
                                row.status?.let { addProperty("status", it) }
                                row.logLength?.let { addProperty("logLength", it) }
                            },
                        )
                    }
                },
            )
        }

    private fun failureOutcome(failure: ApexLogViewerRuntimeException, includeMessage: Boolean): JsonObject =
        JsonObject().apply {
            add(
                "failure",
                JsonObject().apply {
                    addProperty("code", failure.code)
                    if (includeMessage) addProperty("message", failure.message)
                },
            )
        }

    private fun normalizeWorkspacePath(value: String, workspaceRoot: Path): String {
        val normalizedValue = value.replace('\\', '/')
        val normalizedRoot = workspaceRoot.toString().replace('\\', '/').removeSuffix("/")
        return when {
            normalizedValue == normalizedRoot -> WORKSPACE_TOKEN
            normalizedValue.startsWith("$normalizedRoot/") -> WORKSPACE_TOKEN + normalizedValue.removePrefix(normalizedRoot)
            else -> value
        }
    }

    private fun replaceWorkspaceToken(value: JsonElement, workspaceRoot: Path): JsonElement = when {
        value.isJsonArray -> JsonArray().apply {
            value.asJsonArray.forEach { add(replaceWorkspaceToken(it, workspaceRoot)) }
        }
        value.isJsonObject -> JsonObject().apply {
            value.asJsonObject.entrySet().forEach { (name, element) ->
                add(name, replaceWorkspaceToken(element, workspaceRoot))
            }
        }
        value.isJsonPrimitive && value.asJsonPrimitive.isString ->
            JsonPrimitive(value.asString.replace(WORKSPACE_TOKEN, workspaceRoot.toString()))
        else -> value.deepCopy()
    }

    private fun writeWorkspace(root: Path, entries: JsonArray) {
        for (entryElement in entries) {
            val entry = entryElement.asJsonObject
            val destination = root.resolve(entry["path"].asString).normalize()
            assertTrue("unsafe workspace path: ${entry["path"]}", destination != root && destination.startsWith(root))
            Files.createDirectories(destination.parent)
            Files.writeString(destination, entry["content"].asString, StandardCharsets.UTF_8)
        }
    }

    private fun readWorkspace(root: Path): JsonArray =
        JsonArray().apply {
            Files.walk(root).use { paths ->
                paths.filter(Files::isRegularFile).sorted().forEach { file ->
                    add(
                        JsonObject().apply {
                            addProperty("path", root.relativize(file).invariantSeparatorsPathString)
                            addProperty("content", Files.readString(file, StandardCharsets.UTF_8))
                        },
                    )
                }
            }
        }

    private fun deleteRecursively(root: Path) {
        if (!Files.exists(root)) return
        Files.walk(root).use { paths -> paths.sorted(Comparator.reverseOrder()).forEach(Files::deleteIfExists) }
    }

    private fun parseJson(path: Path): JsonElement = JsonParser.parseString(Files.readString(path, StandardCharsets.UTF_8))
}

private class ScriptedProcessDouble(interactions: JsonArray) : RuntimeProcess {
    private val remaining = interactions.map { it.asJsonObject.deepCopy() }.toMutableList()

    override suspend fun execute(request: ProcessRequest): ProcessResponse {
        val requestJson = JsonObject().apply {
            addProperty("executable", request.executable)
            add("arguments", JsonArray().apply { request.arguments.forEach { add(it) } })
            request.cwd?.let { addProperty("cwd", it.toString()) }
        }
        val interaction = takeMatching(remaining, requestJson, "process")
        val response = interaction["response"].asJsonObject
        return ProcessResponse(response["exitCode"].asInt, response["stdout"].asString, response["stderr"].asString)
    }

    fun assertSatisfied() {
        assertTrue("unconsumed process interactions: ${remaining.map { it["id"].asString }}", remaining.isEmpty())
    }
}

private class ScriptedHttpDouble(interactions: JsonArray) : RuntimeHttp {
    private val remaining = interactions.map { it.asJsonObject.deepCopy() }.toMutableList()

    override suspend fun execute(request: HttpRequest): HttpResponse {
        val requestJson = JsonObject().apply {
            addProperty("method", request.method)
            addProperty("url", request.url)
            if (request.headers.isNotEmpty()) {
                add(
                    "headers",
                    JsonObject().apply {
                        request.headers.toSortedMap().forEach { (name, value) -> addProperty(name, value) }
                    },
                )
            }
            request.body?.let { addProperty("body", it) }
        }
        val interaction = takeMatching(remaining, requestJson, "HTTP")
        val response = interaction["response"].asJsonObject
        return HttpResponse(
            status = response["status"].asInt,
            headers = response["headers"].asJsonObject.entrySet().associate { it.key to it.value.asString },
            body = response.get("body")?.takeUnless(JsonElement::isJsonNull)?.toString(),
        )
    }

    fun assertSatisfied() {
        assertTrue("unconsumed HTTP interactions: ${remaining.map { it["id"].asString }}", remaining.isEmpty())
    }
}

private fun takeMatching(remaining: MutableList<JsonObject>, request: JsonObject, boundary: String): JsonObject {
    val index = remaining.indexOfFirst { it["request"] == request }
    check(index >= 0) { "unexpected $boundary request: $request" }
    return remaining.removeAt(index)
}
