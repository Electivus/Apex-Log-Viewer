package com.electivus.apexlogviewer.project

import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service

@Service(Service.Level.PROJECT)
class ApexLogViewerProjectService : Disposable {
    internal var isDisposed: Boolean = false
        private set

    override fun dispose() {
        isDisposed = true
    }
}
