package com.electivus.apexlogviewer.runtime

import java.nio.file.Path

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

data class RuntimeDependencies(
    val process: RuntimeProcess,
    val http: RuntimeHttp,
)
