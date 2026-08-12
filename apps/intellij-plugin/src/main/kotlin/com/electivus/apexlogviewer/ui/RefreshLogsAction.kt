package com.electivus.apexlogviewer.ui

import com.electivus.apexlogviewer.ApexLogViewerBundle
import com.electivus.apexlogviewer.project.ApexLogViewerProjectService
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.components.service
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages

class RefreshLogsAction : DumbAwareAction() {
    override fun actionPerformed(event: AnActionEvent) {
        event.project?.service<ApexLogViewerProjectService>()?.refresh()
    }

    override fun update(event: AnActionEvent) {
        val project = event.project
        event.presentation.isEnabled = project != null &&
            !project.isDisposed &&
            project.service<ApexLogViewerProjectService>().state.value.isRefreshing.not()
    }

    companion object {
        const val ID = "ApexLogViewer.RefreshLogs"
    }
}

class LoadMoreLogsAction : DumbAwareAction() {
    override fun actionPerformed(event: AnActionEvent) {
        event.project?.service<ApexLogViewerProjectService>()?.loadMore()
    }

    override fun update(event: AnActionEvent) {
        val project = event.project
        val state = project?.takeUnless { it.isDisposed }
            ?.service<ApexLogViewerProjectService>()
            ?.state
            ?.value
        event.presentation.isEnabled = state?.hasMoreLogs == true &&
            state.search.query.isEmpty() &&
            !state.isLoadingMore &&
            !state.isDownloadingAll &&
            !state.search.isSearching
    }

    companion object {
        const val ID = "ApexLogViewer.LoadMoreLogs"
    }
}

class CancelLogSearchAction : DumbAwareAction() {
    override fun actionPerformed(event: AnActionEvent) {
        event.project?.service<ApexLogViewerProjectService>()?.cancelSearch()
    }

    override fun update(event: AnActionEvent) {
        val search = event.project?.takeUnless { it.isDisposed }
            ?.service<ApexLogViewerProjectService>()?.state?.value?.search
        event.presentation.isEnabled = search?.let { it.isSearching || it.isRemoteSearching } == true
    }

    companion object { const val ID = "ApexLogViewer.CancelSearch" }
}

class ContinueLogSearchAction : DumbAwareAction() {
    override fun actionPerformed(event: AnActionEvent) {
        event.project?.service<ApexLogViewerProjectService>()?.continueSearch()
    }

    override fun update(event: AnActionEvent) {
        val search = event.project?.takeUnless { it.isDisposed }
            ?.service<ApexLogViewerProjectService>()?.state?.value?.search
        event.presentation.isEnabled = search?.canContinue == true && !search.isSearching
    }

    companion object { const val ID = "ApexLogViewer.ContinueSearch" }
}

class RetryLogSearchAction : DumbAwareAction() {
    override fun actionPerformed(event: AnActionEvent) {
        event.project?.service<ApexLogViewerProjectService>()?.retrySearch()
    }

    override fun update(event: AnActionEvent) {
        val state = event.project?.takeUnless { it.isDisposed }
            ?.service<ApexLogViewerProjectService>()?.state?.value
        event.presentation.isEnabled = state != null && state.search.query.isNotEmpty() &&
            (state.failure != null || state.search.failedLogIds.isNotEmpty())
    }

    companion object { const val ID = "ApexLogViewer.RetrySearch" }
}

class DownloadAllLogsAction(
    private val confirmation: (Project) -> Boolean = { project ->
        Messages.showYesNoDialog(
            project,
            ApexLogViewerBundle.message("action.downloadAll.confirm.message"),
            ApexLogViewerBundle.message("action.downloadAll.confirm.title"),
            ApexLogViewerBundle.message("action.downloadAll.confirm.yes"),
            Messages.getCancelButton(),
            Messages.getQuestionIcon(),
        ) == Messages.YES
    },
) : DumbAwareAction() {
    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project?.takeUnless { it.isDisposed } ?: return
        if (confirmation(project)) project.service<ApexLogViewerProjectService>().downloadAll()
    }

    override fun update(event: AnActionEvent) {
        val state = event.project?.takeUnless { it.isDisposed }
            ?.service<ApexLogViewerProjectService>()?.state?.value
        event.presentation.isEnabled = state != null && state.selectedOrg != null &&
            state.search.query.isEmpty() &&
            !state.isDownloadingAll && !state.isRefreshing && !state.isLoadingMore && !state.search.isSearching
    }

    companion object { const val ID = "ApexLogViewer.DownloadAllLogs" }
}

class CancelDownloadAllLogsAction : DumbAwareAction() {
    override fun actionPerformed(event: AnActionEvent) {
        event.project?.service<ApexLogViewerProjectService>()?.cancelDownloadAll()
    }

    override fun update(event: AnActionEvent) {
        val state = event.project?.takeUnless { it.isDisposed }
            ?.service<ApexLogViewerProjectService>()?.state?.value
        event.presentation.isEnabled = state?.isDownloadingAll == true
    }

    companion object { const val ID = "ApexLogViewer.CancelDownloadAll" }
}
