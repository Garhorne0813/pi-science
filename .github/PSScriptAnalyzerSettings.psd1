@{
    # Start with correctness/security rules that also support PowerShell 5.1.
    IncludeRules = @(
        'PSAvoidUsingEmptyCatchBlock',
        'PSAvoidUsingInvokeExpression',
        'PSAvoidUsingPlainTextForPassword',
        'PSAvoidUsingConvertToSecureStringWithPlainText',
        'PSUsePSCredentialType',
        'PSAvoidAssignmentToAutomaticVariable'
    )
    Severity = @('Error', 'Warning')
}
