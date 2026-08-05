package com.electivus.apexlogviewer

import com.intellij.DynamicBundle
import org.jetbrains.annotations.Nls
import org.jetbrains.annotations.PropertyKey

private const val BUNDLE_NAME = "messages.ApexLogViewerBundle"

object ApexLogViewerBundle : DynamicBundle(BUNDLE_NAME) {
    @Nls
    fun message(@PropertyKey(resourceBundle = BUNDLE_NAME) key: String): String = getMessage(key)
}
