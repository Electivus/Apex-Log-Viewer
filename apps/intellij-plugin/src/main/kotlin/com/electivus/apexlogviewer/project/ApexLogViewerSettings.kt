package com.electivus.apexlogviewer.project

import com.intellij.openapi.components.BaseState
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.SimplePersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.StoragePathMacros

@Service(Service.Level.PROJECT)
@State(
    name = "ElectivusApexLogViewerSettings",
    storages = [Storage(StoragePathMacros.WORKSPACE_FILE)],
)
class ApexLogViewerSettings : SimplePersistentStateComponent<ApexLogViewerSettings.State>(State()) {
    class State : BaseState() {
        var selectedOrg by string()
        var searchQuery by string("")
        var operationFilter by string()
        var statusFilter by string()
        var userFilter by string()
        var errorsOnly by property(false)
        var sortField by string(LogSortField.START_TIME.name)
        var sortDirection by string(LogSortDirection.DESCENDING.name)
    }

    var selectedOrg: String?
        get() = state.selectedOrg
        set(value) {
            state.selectedOrg = value
        }

    var searchQuery: String
        get() = state.searchQuery.orEmpty()
        set(value) {
            state.searchQuery = value
        }

    var viewOptions: LogViewOptions
        get() = LogViewOptions(
            user = state.userFilter,
            operation = state.operationFilter,
            status = state.statusFilter,
            errorsOnly = state.errorsOnly,
            sortField = enumValueOrDefault(state.sortField, LogSortField.START_TIME),
            sortDirection = enumValueOrDefault(state.sortDirection, LogSortDirection.DESCENDING),
        )
        set(value) {
            state.userFilter = value.user
            state.operationFilter = value.operation
            state.statusFilter = value.status
            state.errorsOnly = value.errorsOnly
            state.sortField = value.sortField.name
            state.sortDirection = value.sortDirection.name
        }

    private inline fun <reified T : Enum<T>> enumValueOrDefault(value: String?, fallback: T): T =
        enumValues<T>().firstOrNull { it.name == value } ?: fallback
}
