package com.electivus.apexlogviewer

import junit.framework.TestCase
import java.util.Locale
import java.util.ResourceBundle

class ApexLogViewerLocalizationTest : TestCase() {
    fun testBundlesAreCompleteAndUnsupportedLocalesFallBackToEnglish() {
        val loader = ApexLogViewerBundle::class.java.classLoader
        val english = ResourceBundle.getBundle(BUNDLE_NAME, Locale.ENGLISH, loader, NO_DEFAULT_LOCALE_FALLBACK)
        val brazilianPortuguese =
            ResourceBundle.getBundle(BUNDLE_NAME, Locale.forLanguageTag("pt-BR"), loader, NO_DEFAULT_LOCALE_FALLBACK)
        val unsupported = ResourceBundle.getBundle(BUNDLE_NAME, Locale.FRANCE, loader, NO_DEFAULT_LOCALE_FALLBACK)

        assertEquals(english.keySet(), brazilianPortuguese.keySet())
        assertEquals(
            "Native IntelliJ IDEA access to the Apex Log Lifecycle.",
            english.getString(PLUGIN_DESCRIPTION_KEY),
        )
        assertEquals(
            "Acesso nativo do IntelliJ IDEA ao ciclo de vida de logs do Apex.",
            brazilianPortuguese.getString(PLUGIN_DESCRIPTION_KEY),
        )
        assertEquals(
            "Native IntelliJ IDEA access to the Apex Log Lifecycle.",
            unsupported.getString(PLUGIN_DESCRIPTION_KEY),
        )
        assertEquals("Apex Log Viewer logs", english.getString("toolWindow.logs.accessibleDescription"))
        assertEquals(
            "Logs do Apex Log Viewer",
            brazilianPortuguese.getString("toolWindow.logs.accessibleDescription"),
        )
        assertEquals(
            "Apex Log Viewer logs",
            unsupported.getString("toolWindow.logs.accessibleDescription"),
        )
    }

    companion object {
        private const val BUNDLE_NAME = "messages.ApexLogViewerBundle"
        private const val PLUGIN_DESCRIPTION_KEY = "plugin.com.electivus.apexlogviewer.description"
        private val NO_DEFAULT_LOCALE_FALLBACK =
            ResourceBundle.Control.getNoFallbackControl(ResourceBundle.Control.FORMAT_PROPERTIES)
    }
}
