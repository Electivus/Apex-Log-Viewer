package com.electivus.apexlogviewer.runtime

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.process.CapturingProcessAdapter
import com.intellij.execution.process.CapturingProcessHandler
import com.intellij.execution.process.ProcessEvent
import java.io.File
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest.BodyPublishers
import java.net.http.HttpResponse.BodyHandlers
import java.nio.file.Path
import java.nio.file.Files
import java.time.Duration
import java.time.Clock
import kotlinx.coroutines.future.await
import kotlinx.coroutines.suspendCancellableCoroutine

data class ProcessRequest(
    val executable: String,
    val arguments: List<String>,
    val cwd: Path? = null,
)

data class ProcessResponse(
    val exitCode: Int,
    val stdout: String,
    val stderr: String,
)

fun interface RuntimeProcess {
    suspend fun execute(request: ProcessRequest): ProcessResponse
}

data class HttpRequest(
    val method: String,
    val url: String,
    val headers: Map<String, String> = emptyMap(),
    val body: String? = null,
)

data class HttpResponse(
    val status: Int,
    val headers: Map<String, String>,
    val body: String? = null,
)

fun interface RuntimeHttp {
    suspend fun execute(request: HttpRequest): HttpResponse
}

data class RuntimeDependencies @JvmOverloads constructor(
    val process: RuntimeProcess,
    val http: RuntimeHttp,
    val clock: Clock = Clock.systemUTC(),
)

fun defaultRuntimeDependencies(): RuntimeDependencies =
    RuntimeDependencies(
        process = NativeRuntimeProcess(),
        http = NativeRuntimeHttp(),
    )

internal class NativeRuntimeProcess : RuntimeProcess {
    override suspend fun execute(request: ProcessRequest): ProcessResponse = suspendCancellableCoroutine { continuation ->
        val executable = resolveRuntimeExecutable(
            executable = request.executable,
            pathValue = System.getenv("PATH").orEmpty(),
            pathExtensions = System.getenv("PATHEXT").orEmpty(),
            isWindows = System.getProperty("os.name").startsWith("Windows"),
        )
        val commandLine = GeneralCommandLine(executable)
            .withParameters(request.arguments)
            .withWorkDirectory(request.cwd?.toFile())
        val handler = CapturingProcessHandler(commandLine)
        val capture = object : CapturingProcessAdapter() {
            override fun processTerminated(event: ProcessEvent) {
                super.processTerminated(event)
                val output = output
                runCatching {
                    continuation.resumeWith(
                        Result.success(ProcessResponse(output.exitCode, output.stdout, output.stderr)),
                    )
                }
            }
        }
        handler.addProcessListener(capture)
        continuation.invokeOnCancellation {
            handler.destroyProcess()
        }
        if (continuation.isActive) handler.startNotify() else handler.destroyProcess()
    }
}

internal fun resolveRuntimeExecutable(
    executable: String,
    pathValue: String,
    pathExtensions: String,
    isWindows: Boolean,
): String {
    if (!isWindows || '/' in executable || '\\' in executable) return executable
    val extensions = pathExtensions.split(';')
        .map(String::trim)
        .filter(String::isNotEmpty)
        .map { if (it.startsWith('.')) it else ".$it" }
    val candidateNames = if (Path.of(executable).fileName.toString().contains('.')) {
        listOf(executable)
    } else {
        extensions.map { executable + it.lowercase() } + executable
    }
    pathValue.split(if (isWindows) ';' else File.pathSeparatorChar).forEach { rawDirectory ->
        val directory = rawDirectory.trim().trim('"')
        if (directory.isEmpty()) return@forEach
        candidateNames.forEach { name ->
            val candidate = runCatching { Path.of(directory).resolve(name) }.getOrNull() ?: return@forEach
            if (Files.isRegularFile(candidate)) return candidate.toAbsolutePath().normalize().toString()
        }
    }
    return executable
}

private class NativeRuntimeHttp(
    private val client: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(30))
        .followRedirects(HttpClient.Redirect.NEVER)
        .build(),
) : RuntimeHttp {
    override suspend fun execute(request: HttpRequest): HttpResponse {
        val bodyPublisher = request.body?.let(BodyPublishers::ofString) ?: BodyPublishers.noBody()
        val builder = java.net.http.HttpRequest.newBuilder(URI.create(request.url))
            .timeout(Duration.ofMinutes(2))
            .method(request.method, bodyPublisher)
        request.headers.forEach(builder::header)
        val response = client.sendAsync(builder.build(), BodyHandlers.ofString()).await()
        return HttpResponse(
            status = response.statusCode(),
            headers = response.headers().map().mapValues { (_, values) -> values.joinToString(",") },
            body = response.body(),
        )
    }
}
