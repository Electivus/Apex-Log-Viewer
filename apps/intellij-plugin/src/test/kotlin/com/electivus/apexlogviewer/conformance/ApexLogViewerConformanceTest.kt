package com.electivus.apexlogviewer.conformance

import junit.framework.TestCase
import kotlinx.coroutines.runBlocking

class ApexLogViewerConformanceTest : TestCase() {
    fun testKotlinPublicRuntimeFacadeConformsToSharedV1Corpus() = runBlocking {
        KotlinConformanceHarness.runV1Corpus()
    }
}
