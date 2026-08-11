import org.gradle.api.tasks.PathSensitivity
import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.TestFrameworkType
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    kotlin("jvm") version "2.4.10"
    id("org.jetbrains.intellij.platform") version "2.18.1"
}

group = "com.electivus"
version = "0.1.0"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        intellijIdea("2026.1")
        testFramework(TestFrameworkType.Platform)
    }

    testImplementation("junit:junit:4.13.2")
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_21
        freeCompilerArgs.add("-jvm-default=no-compatibility")
    }
}

java {
    sourceCompatibility = JavaVersion.VERSION_21
    targetCompatibility = JavaVersion.VERSION_21
}

intellijPlatform {
    pluginConfiguration {
        // Stable identity and vendor live in plugin.xml; Gradle owns the build-produced version and range.
        version = project.version.toString()
        description = providers.fileContents(
            layout.projectDirectory.file("description.html"),
        ).asText

        ideaVersion {
            sinceBuild = "261"
            untilBuild = "262.*"
        }
    }

    pluginVerification {
        ides {
            create(IntelliJPlatformType.IntellijIdea, "2026.1")
            create(IntelliJPlatformType.IntellijIdea, "2026.2")
        }
    }

    signing {
        certificateChain = providers.environmentVariable("CERTIFICATE_CHAIN")
        privateKey = providers.environmentVariable("PRIVATE_KEY")
        password = providers.environmentVariable("PRIVATE_KEY_PASSWORD")
    }

    buildSearchableOptions = false
}

val conformanceCorpus = rootProject.projectDir.resolve("../../test/conformance")
val localIntellijPath = providers.environmentVariable("ALV_INTELLIJ_LOCAL_PATH")

intellijPlatformTesting {
    testIde.register("testLocalIde") {
        localPath.set(layout.dir(localIntellijPath.map(::file)))
        sandboxDirectory.set(layout.buildDirectory.dir("idea-sandbox-local"))
        task {
            useJUnit()
            inputs.dir(conformanceCorpus).withPathSensitivity(PathSensitivity.RELATIVE)
            systemProperty("alv.conformance.root", conformanceCorpus.canonicalPath)
        }
    }
}

tasks {
    test {
        useJUnit()
        inputs.dir(conformanceCorpus).withPathSensitivity(PathSensitivity.RELATIVE)
        systemProperty("alv.conformance.root", conformanceCorpus.canonicalPath)
    }
}
