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

        ideaVersion {
            sinceBuild = "261"
            untilBuild = "262.*"
        }
    }

    buildSearchableOptions = false
}

tasks {
    test {
        useJUnit()
        systemProperty("alv.conformance.root", rootProject.projectDir.resolve("../../test/conformance").canonicalPath)
    }
}
