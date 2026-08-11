package com.electivus.apexlogviewer.ui

import com.electivus.apexlogviewer.ApexLogViewerBundle
import com.electivus.apexlogviewer.project.ApexLogViewerProjectService
import com.electivus.apexlogviewer.project.LogSortDirection
import com.electivus.apexlogviewer.project.LogSortField
import com.electivus.apexlogviewer.project.LogsProjectState
import com.electivus.apexlogviewer.project.SearchProjectState
import com.electivus.apexlogviewer.runtime.LogListRow
import com.electivus.apexlogviewer.runtime.LogTriageSummary
import com.electivus.apexlogviewer.runtime.OrgListItem
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionUiKind
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.actionSystem.DataSink
import com.intellij.openapi.actionSystem.UiDataProvider
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.ex.ActionUtil
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.Disposable
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.ui.CollectionComboBoxModel
import com.intellij.ui.DocumentAdapter
import com.intellij.ui.SearchTextField
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBPanel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.table.JBTable
import java.awt.BorderLayout
import java.awt.FlowLayout
import java.awt.event.ItemEvent
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.event.DocumentEvent
import javax.swing.event.RowSorterEvent
import javax.swing.RowSorter
import javax.swing.SortOrder
import javax.swing.table.AbstractTableModel
import javax.swing.table.TableRowSorter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

class LogsToolWindowPanel(
    private val project: Project,
    private val service: ApexLogViewerProjectService,
) : JBPanel<LogsToolWindowPanel>(BorderLayout()), UiDataProvider {
    private val orgModel = CollectionComboBoxModel<OrgChoice>()
    private val orgSelector = com.intellij.openapi.ui.ComboBox(orgModel)
    private val searchField = SearchTextField(false)
    private val operationModel = CollectionComboBoxModel<FilterChoice>()
    private val operationFilter = com.intellij.openapi.ui.ComboBox(operationModel)
    private val userModel = CollectionComboBoxModel<FilterChoice>()
    private val userFilter = com.intellij.openapi.ui.ComboBox(userModel)
    private val statusModel = CollectionComboBoxModel<FilterChoice>()
    private val statusFilter = com.intellij.openapi.ui.ComboBox(statusModel)
    private val errorsOnlyFilter = JBCheckBox(ApexLogViewerBundle.message("toolWindow.logs.filters.errorsOnly"))
    private val tableModel = ApexLogsTableModel()
    private val logsTable = JBTable(tableModel)
    private val logsScrollPane = JBScrollPane(logsTable)
    private val statusLabel = JBLabel()
    private val observationScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var isRendering = false

    init {
        orgSelector.accessibleContext?.accessibleName = ApexLogViewerBundle.message("toolWindow.logs.org.accessibleName")
        searchField.textEditor.accessibleContext?.accessibleName =
            ApexLogViewerBundle.message("toolWindow.logs.search.accessibleName")
        operationFilter.accessibleContext?.accessibleName =
            ApexLogViewerBundle.message("toolWindow.logs.filters.operation.accessibleName")
        userFilter.accessibleContext?.accessibleName =
            ApexLogViewerBundle.message("toolWindow.logs.filters.user.accessibleName")
        statusFilter.accessibleContext?.accessibleName =
            ApexLogViewerBundle.message("toolWindow.logs.filters.status.accessibleName")
        errorsOnlyFilter.accessibleContext?.accessibleName =
            ApexLogViewerBundle.message("toolWindow.logs.filters.errorsOnly.accessibleName")
        logsTable.accessibleContext?.accessibleName = ApexLogViewerBundle.message("toolWindow.logs.table.accessibleName")
        logsTable.autoCreateRowSorter = true
        (logsTable.rowSorter as? TableRowSorter<*>)?.apply {
            setSortable(2, false)
            setSortable(6, false)
        }
        statusLabel.accessibleContext?.accessibleName = ApexLogViewerBundle.message("toolWindow.logs.status.accessibleName")

        val actionManager = ActionManager.getInstance()
        val toolbarActions = listOf(
            RefreshLogsAction.ID,
            LoadMoreLogsAction.ID,
            CancelLogSearchAction.ID,
            ContinueLogSearchAction.ID,
            RetryLogSearchAction.ID,
            DownloadAllLogsAction.ID,
            CancelDownloadAllLogsAction.ID,
            OpenParsedLogAction.ID,
            OpenRawLogAction.ID,
            OpenInIlluminatedCloudAction.ID,
        ).map { requireNotNull(actionManager.getAction(it)) }
        val toolbar = ActionManager.getInstance().createActionToolbar(
            "ApexLogViewer.LogsToolbar",
            DefaultActionGroup(toolbarActions),
            true,
        )
        toolbar.targetComponent = this

        val header = JBPanel<JBPanel<*>>(BorderLayout())
        header.add(toolbar.component, BorderLayout.WEST)
        header.add(orgSelector, BorderLayout.CENTER)
        val queryAndFilters = JBPanel<JBPanel<*>>(BorderLayout())
        queryAndFilters.add(searchField, BorderLayout.NORTH)
        val filters = JBPanel<JBPanel<*>>(FlowLayout(FlowLayout.LEADING, 4, 2))
        filters.add(JBLabel(ApexLogViewerBundle.message("toolWindow.logs.filters.user")))
        filters.add(userFilter)
        filters.add(JBLabel(ApexLogViewerBundle.message("toolWindow.logs.filters.operation")))
        filters.add(operationFilter)
        filters.add(JBLabel(ApexLogViewerBundle.message("toolWindow.logs.filters.status")))
        filters.add(statusFilter)
        filters.add(errorsOnlyFilter)
        queryAndFilters.add(filters, BorderLayout.SOUTH)
        header.add(queryAndFilters, BorderLayout.SOUTH)
        add(header, BorderLayout.NORTH)
        add(logsScrollPane, BorderLayout.CENTER)
        add(statusLabel, BorderLayout.SOUTH)

        searchField.textEditor.document.addDocumentListener(
            object : DocumentAdapter() {
                override fun textChanged(event: DocumentEvent) {
                    if (!isRendering) service.setSearchQuery(searchField.text)
                }
            },
        )
        orgSelector.addItemListener { event ->
            if (!isRendering && event.stateChange == ItemEvent.SELECTED) {
                (event.item as? OrgChoice)?.org?.username?.let(service::selectOrg)
            }
        }
        operationFilter.addItemListener { event ->
            if (!isRendering && event.stateChange == ItemEvent.SELECTED) {
                service.setViewOptions(service.state.value.viewOptions.copy(operation = (event.item as FilterChoice).value))
            }
        }
        userFilter.addItemListener { event ->
            if (!isRendering && event.stateChange == ItemEvent.SELECTED) {
                service.setViewOptions(service.state.value.viewOptions.copy(user = (event.item as FilterChoice).value))
            }
        }
        statusFilter.addItemListener { event ->
            if (!isRendering && event.stateChange == ItemEvent.SELECTED) {
                service.setViewOptions(service.state.value.viewOptions.copy(status = (event.item as FilterChoice).value))
            }
        }
        errorsOnlyFilter.addItemListener { event ->
            if (!isRendering) {
                service.setViewOptions(
                    service.state.value.viewOptions.copy(errorsOnly = event.stateChange == ItemEvent.SELECTED),
                )
            }
        }
        logsTable.rowSorter.addRowSorterListener { event ->
            if (isRendering || event.type != RowSorterEvent.Type.SORT_ORDER_CHANGED) return@addRowSorterListener
            val key = logsTable.rowSorter.sortKeys.firstOrNull() ?: return@addRowSorterListener
            val field = logSortFieldForColumn(key.column) ?: return@addRowSorterListener
            val direction = if (key.sortOrder == SortOrder.ASCENDING) {
                LogSortDirection.ASCENDING
            } else {
                LogSortDirection.DESCENDING
            }
            service.setViewOptions(service.state.value.viewOptions.copy(sortField = field, sortDirection = direction))
        }
        logsScrollPane.verticalScrollBar.addAdjustmentListener { event ->
            val bar = event.adjustable
            if (!event.valueIsAdjusting && bar.value + bar.visibleAmount >= bar.maximum - INFINITE_SCROLL_THRESHOLD) {
                service.loadMore()
            }
        }
        logsTable.addMouseListener(
            object : MouseAdapter() {
                override fun mouseClicked(event: MouseEvent) {
                    if (event.clickCount != 2 || logsTable.selectedRow < 0) return
                    val row = tableModel.rowAt(logsTable.convertRowIndexToModel(logsTable.selectedRow)) ?: return
                    val context = logDataContext(project, row = row)
                    val action = requireNotNull(ActionManager.getInstance().getAction(OpenParsedLogAction.ID))
                    val actionEvent = AnActionEvent.createEvent(
                        action,
                        context,
                        action.templatePresentation.clone(),
                        "ApexLogViewer.LogsTable",
                        ActionUiKind.NONE,
                        event,
                    )
                    ActionUtil.performAction(action, actionEvent)
                }
            },
        )
        render(service.state.value)
        Disposer.register(project, Disposable { observationScope.cancel() })
        observationScope.launch {
            service.state.collectLatest { state ->
                ApplicationManager.getApplication().invokeLater {
                    if (!project.isDisposed) render(state)
                }
            }
        }
    }

    private fun render(state: LogsProjectState) {
        isRendering = true
        val selectedViewRow = logsTable.selectedRow
        val selectedId = if (selectedViewRow >= 0) {
            tableModel.rowAt(logsTable.convertRowIndexToModel(selectedViewRow))?.id
        } else {
            null
        }
        val choices = state.orgs.map(::OrgChoice)
        orgModel.replaceAll(choices)
        orgModel.selectedItem = choices.firstOrNull { it.org.username == state.selectedOrg }
        val operations = filterChoices(
            ApexLogViewerBundle.message("toolWindow.logs.filters.allOperations"),
            state.availableOperations,
            state.viewOptions.operation,
        )
        operationModel.replaceAll(operations)
        operationModel.selectedItem = operations.first { it.value == state.viewOptions.operation }
        val users = filterChoices(
            ApexLogViewerBundle.message("toolWindow.logs.filters.allUsers"),
            state.availableUsers,
            state.viewOptions.user,
        )
        userModel.replaceAll(users)
        userModel.selectedItem = users.first { it.value == state.viewOptions.user }
        val statuses = filterChoices(
            ApexLogViewerBundle.message("toolWindow.logs.filters.allStatuses"),
            state.availableStatuses,
            state.viewOptions.status,
        )
        statusModel.replaceAll(statuses)
        statusModel.selectedItem = statuses.first { it.value == state.viewOptions.status }
        errorsOnlyFilter.isSelected = state.viewOptions.errorsOnly
        if (searchField.text != state.search.query) searchField.text = state.search.query
        tableModel.replaceAll(state.logs, state.search, state.triageByLogId)
        val desiredSortKey = RowSorter.SortKey(
            columnForSortField(state.viewOptions.sortField),
            if (state.viewOptions.sortDirection == LogSortDirection.ASCENDING) SortOrder.ASCENDING else SortOrder.DESCENDING,
        )
        if (logsTable.rowSorter.sortKeys != listOf(desiredSortKey)) {
            logsTable.rowSorter.sortKeys = listOf(desiredSortKey)
        }
        selectedId?.let { id ->
            tableModel.indexOf(id).takeIf { it >= 0 }?.let { modelRow ->
                val viewRow = logsTable.convertRowIndexToView(modelRow)
                if (viewRow >= 0) logsTable.setRowSelectionInterval(viewRow, viewRow)
            }
        }
        statusLabel.text = when {
            state.isRefreshing -> ApexLogViewerBundle.message("toolWindow.logs.status.refreshing")
            state.isLoadingMore -> ApexLogViewerBundle.message("toolWindow.logs.status.loadingMore")
            state.isDownloadingAll -> ApexLogViewerBundle.message(
                "toolWindow.logs.status.downloadingAll",
                state.downloadProcessed,
                state.downloadFailureCount,
            )
            state.isMaterializingSelectedLog ->
                ApexLogViewerBundle.message("toolWindow.logs.status.materializingSelected")
            state.isAcquiringBodies -> ApexLogViewerBundle.message(
                "toolWindow.logs.status.acquiringBodies",
                state.acquisitionProcessed,
                state.acquisitionFailureCount,
            )
            state.failure != null -> localizedFailure(state.failure.code)
            state.search.isRemoteSearching -> ApexLogViewerBundle.message(
                "toolWindow.logs.status.searchingRemote",
                state.search.pagesExamined,
                state.search.bodiesProcessed,
                state.search.totalMatches,
            )
            state.search.query.isNotEmpty() && state.search.query.length < 3 ->
                ApexLogViewerBundle.message("toolWindow.logs.status.localOnly", state.search.matches.size)
            state.search.query.isNotEmpty() -> ApexLogViewerBundle.message(
                "toolWindow.logs.status.searchReady",
                state.search.matches.size,
                state.search.partialFailureCount,
            )
            state.logs.isEmpty() -> ApexLogViewerBundle.message("toolWindow.logs.empty")
            else -> ApexLogViewerBundle.message("toolWindow.logs.status.ready")
        }
        isRendering = false
    }

    override fun uiDataSnapshot(sink: DataSink) {
        val selected = logsTable.selectedRow
        if (selected >= 0) {
            tableModel.rowAt(logsTable.convertRowIndexToModel(selected))
                ?.let { sink.set(ApexLogViewerDataKeys.LOG_ROW, it) }
        }
    }

    private fun filterChoices(allLabel: String, values: List<String>, selected: String?): List<FilterChoice> =
        listOf(FilterChoice(null, allLabel)) + (values + listOfNotNull(selected)).distinct().map { FilterChoice(it, it) }

    private fun columnForSortField(field: LogSortField): Int = when (field) {
        LogSortField.START_TIME -> 0
        LogSortField.OPERATION -> 1
        LogSortField.STATUS -> 3
        LogSortField.SIZE -> 4
        LogSortField.LOG_ID -> 5
    }

    companion object {
        private const val INFINITE_SCROLL_THRESHOLD = 32
    }
}

internal fun logSortFieldForColumn(column: Int): LogSortField? = when (column) {
    0 -> LogSortField.START_TIME
    1 -> LogSortField.OPERATION
    3 -> LogSortField.STATUS
    4 -> LogSortField.SIZE
    5 -> LogSortField.LOG_ID
    else -> null
}

private data class OrgChoice(val org: OrgListItem) {
    override fun toString(): String = org.alias?.let { "$it — ${org.username}" } ?: org.username
}

private data class FilterChoice(val value: String?, val label: String) {
    override fun toString(): String = label
}

internal class ApexLogsTableModel : AbstractTableModel() {
    private var rows: List<LogRowView> = emptyList()
    private val columnKeys = listOf(
        "toolWindow.logs.column.startTime",
        "toolWindow.logs.column.operation",
        "toolWindow.logs.column.application",
        "toolWindow.logs.column.status",
        "toolWindow.logs.column.length",
        "toolWindow.logs.column.id",
        "toolWindow.logs.column.match",
    )

    override fun getRowCount(): Int = rows.size

    override fun getColumnCount(): Int = columnKeys.size

    override fun getColumnName(column: Int): String = ApexLogViewerBundle.message(columnKeys[column])

    override fun getColumnClass(columnIndex: Int): Class<*> = when (columnIndex) {
        4 -> Int::class.javaObjectType
        else -> String::class.java
    }

    override fun getValueAt(rowIndex: Int, columnIndex: Int): Any = when (columnIndex) {
        0 -> rows[rowIndex].log.startTime.orEmpty()
        1 -> rows[rowIndex].log.operation.orEmpty()
        2 -> rows[rowIndex].log.application.orEmpty()
        3 -> rows[rowIndex].triage?.let { triage ->
            ApexLogViewerBundle.message(
                "toolWindow.logs.statusWithTriage",
                rows[rowIndex].log.status.orEmpty(),
                localizedTriageReason(triage),
            )
        } ?: rows[rowIndex].log.status.orEmpty()
        4 -> rows[rowIndex].log.logLength ?: 0
        5 -> rows[rowIndex].log.id
        6 -> rows[rowIndex].match
        else -> ""
    }

    fun replaceAll(
        nextRows: List<LogListRow>,
        search: SearchProjectState,
        triageByLogId: Map<String, LogTriageSummary>,
    ) {
        val matches = search.matches.associateBy { it.logId }
        val pending = search.pendingLogIds.toSet()
        val failed = search.failedLogIds.toSet()
        rows = nextRows.map { log ->
            LogRowView(
                log,
                matches[log.id]?.snippet.orEmpty().ifEmpty {
                    when (log.id) {
                        in failed -> ApexLogViewerBundle.message("toolWindow.logs.match.failed")
                        in pending -> ApexLogViewerBundle.message("toolWindow.logs.match.pending")
                        else -> ""
                    }
                },
                triageByLogId[log.id]?.takeIf { it.reasons.isNotEmpty() },
            )
        }
        fireTableDataChanged()
    }

    fun rowAt(index: Int): LogListRow? = rows.getOrNull(index)?.log

    fun indexOf(logId: String): Int = rows.indexOfFirst { it.log.id == logId }
}

private data class LogRowView(val log: LogListRow, val match: String, val triage: LogTriageSummary?)

internal fun localizedFailure(code: String): String = ApexLogViewerBundle.message(
    when (code) {
        "no-authenticated-orgs" -> "error.noAuthenticatedOrgs"
        "org-resolution" -> "error.orgResolution"
        "remote-acquisition" -> "error.remoteAcquisition"
        "local-persistence", "local-read" -> "error.localPersistence"
        "invalid-log" -> "error.invalidLog"
        else -> "error.unexpected"
    },
)
