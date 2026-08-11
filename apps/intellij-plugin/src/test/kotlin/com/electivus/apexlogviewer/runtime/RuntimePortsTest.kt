package com.electivus.apexlogviewer.runtime

import java.nio.file.Files
import java.nio.file.Path
import java.util.Comparator
import kotlin.system.measureTimeMillis
import junit.framework.TestCase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout

class RuntimePortsTest : TestCase() {
    fun testNativeProcessCancellationDestroysABlockedChildPromptly() = runBlocking {
        val sourceRoot = Files.createTempDirectory("alv-process-cancellation-")
        val source = sourceRoot.resolve("BlockingRuntimeProcess.java")
        val pidFile = sourceRoot.resolve("pid")
        Files.writeString(
            source,
            "import java.nio.file.*; public class BlockingRuntimeProcess { " +
                "public static void main(String[] args) throws Exception { " +
                "Files.writeString(Path.of(args[0]), Long.toString(ProcessHandle.current().pid())); Thread.sleep(30000); } }",
        )
        val javaExecutable = Path.of(
            System.getProperty("java.home"),
            "bin",
            if (System.getProperty("os.name").startsWith("Windows")) "java.exe" else "java",
        )
        try {
            val execution = async(Dispatchers.Default) {
                NativeRuntimeProcess().execute(
                    ProcessRequest(
                        executable = javaExecutable.toString(),
                        arguments = listOf(source.toString(), pidFile.toString()),
                    ),
                )
            }
            withTimeout(5_000) {
                while (!Files.exists(pidFile)) delay(25)
            }
            val childPid = Files.readString(pidFile).toLong()
            assertTrue("the child process must still be blocked before cancellation", execution.isActive)

            val cancellationMillis = measureTimeMillis {
                execution.cancelAndJoin()
            }

            assertTrue("process cancellation took ${cancellationMillis}ms", cancellationMillis < 5_000)
            withTimeout(5_000) {
                while (ProcessHandle.of(childPid).map(ProcessHandle::isAlive).orElse(false)) delay(25)
            }
        } finally {
            Files.walk(sourceRoot).use { paths -> paths.sorted(Comparator.reverseOrder()).forEach(Files::deleteIfExists) }
        }
    }

    fun testWindowsSalesforceCmdShimIsResolvedAndExecuted() = runBlocking {
        if (!System.getProperty("os.name").startsWith("Windows")) return@runBlocking
        val shimRoot = Files.createTempDirectory("alv-sf-shim-")
        val extensionlessShim = shimRoot.resolve("sf")
        val shim = shimRoot.resolve("sf.cmd")
        Files.writeString(extensionlessShim, "#!/bin/sh\necho wrong-shim\n")
        Files.writeString(shim, "@echo off\r\necho sf-shim-ok\r\n")
        try {
            val resolved = resolveRuntimeExecutable(
                executable = "sf",
                pathValue = shimRoot.toString(),
                pathExtensions = ".COM;.EXE;.BAT;.CMD",
                isWindows = true,
            )
            assertEquals(shim.toAbsolutePath().normalize().toString(), resolved)
            val result = NativeRuntimeProcess().execute(ProcessRequest(resolved, listOf("--version")))
            assertEquals(0, result.exitCode)
            assertTrue(result.stdout.contains("sf-shim-ok"))
        } finally {
            Files.walk(shimRoot).use { paths -> paths.sorted(Comparator.reverseOrder()).forEach(Files::deleteIfExists) }
        }
    }
}
