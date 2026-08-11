package com.electivus.apexlogviewer.project

import com.intellij.openapi.components.BaseState
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.SimplePersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage

@Service(Service.Level.APP)
@State(name = "ElectivusApexLogViewerApplicationSettings", storages = [Storage("apexLogViewer.xml")])
class ApexLogViewerApplicationSettings :
    SimplePersistentStateComponent<ApexLogViewerApplicationSettings.State>(State()) {
    class State : BaseState() {
        var pageSize by property(50)
        var processingConcurrency by property(4)
        var traceLogging by property(false)
    }

    var pageSize: Int
        get() = state.pageSize.coerceIn(1, 200)
        set(value) {
            state.pageSize = value.coerceIn(1, 200)
        }

    var processingConcurrency: Int
        get() = state.processingConcurrency.coerceIn(1, 16)
        set(value) {
            state.processingConcurrency = value.coerceIn(1, 16)
        }

    var traceLogging: Boolean
        get() = state.traceLogging
        set(value) {
            state.traceLogging = value
        }
}
