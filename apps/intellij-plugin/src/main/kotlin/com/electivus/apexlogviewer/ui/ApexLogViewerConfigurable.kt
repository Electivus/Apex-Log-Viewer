package com.electivus.apexlogviewer.ui

import com.electivus.apexlogviewer.ApexLogViewerBundle
import com.electivus.apexlogviewer.project.ApexLogViewerApplicationSettings
import com.intellij.openapi.components.service
import com.intellij.openapi.options.SearchableConfigurable
import com.intellij.ui.components.JBCheckBox
import com.intellij.util.ui.FormBuilder
import javax.swing.JComponent
import javax.swing.JSpinner
import javax.swing.SpinnerNumberModel

class ApexLogViewerConfigurable : SearchableConfigurable {
    private val settings = service<ApexLogViewerApplicationSettings>()
    private val pageSize = JSpinner(SpinnerNumberModel(settings.pageSize, 1, 200, 1))
    private val concurrency = JSpinner(SpinnerNumberModel(settings.processingConcurrency, 1, 16, 1))
    private val traceLogging = JBCheckBox(ApexLogViewerBundle.message("settings.traceLogging"))
    private var component: JComponent? = null

    override fun getId(): String = ID

    override fun getDisplayName(): String = ApexLogViewerBundle.message("settings.displayName")

    override fun createComponent(): JComponent = FormBuilder.createFormBuilder()
        .addLabeledComponent(ApexLogViewerBundle.message("settings.pageSize"), pageSize)
        .addLabeledComponent(ApexLogViewerBundle.message("settings.processingConcurrency"), concurrency)
        .addComponent(traceLogging)
        .addComponentFillVertically(javax.swing.JPanel(), 0)
        .panel
        .also { component = it }

    override fun isModified(): Boolean =
        pageSize.value != settings.pageSize ||
            concurrency.value != settings.processingConcurrency ||
            traceLogging.isSelected != settings.traceLogging

    override fun apply() {
        settings.pageSize = pageSize.value as Int
        settings.processingConcurrency = concurrency.value as Int
        settings.traceLogging = traceLogging.isSelected
    }

    override fun reset() {
        pageSize.value = settings.pageSize
        concurrency.value = settings.processingConcurrency
        traceLogging.isSelected = settings.traceLogging
    }

    override fun disposeUIResources() {
        component = null
    }

    companion object {
        const val ID = "com.electivus.apexlogviewer.settings"
    }
}
